// loom: Loom extension part — background jobs. `bg_start` runs a command in pi's process group
// with its output in a log beside a JSON record (`<sessionDir>/jobs/<sessionId>/`); `bg_wait`
// returns at the job's exit or, at its timeout, with the job's progress. A job that exits with
// nobody waiting wakes the thread: a `loom-jobs` status line (which the pi adapter reads as the
// session pin and the wake chip) then a custom message with `triggerTurn`. Exactly one of the
// waiter or the wake fires; neither when pi itself is going down (the job got the same SIGTERM),
// so the record stays open and the next session start reports the job lost, once.
// A child's submit is refused while a job runs: its wake would start a turn on a finished thread.
// Not detached on purpose: Stop and idle release signal pi's group, so a job never outlives pi.
// The part imports nothing: `source` runs as `(pi, ctx) => { … }` in Loom's assembled extension.
import { agentToolName } from "../../../../mcp/toolkits/workstream/families.ts";
import { LOOM_TOOL_PROSE } from "../../../../mcp/toolkits/workstream/prose.ts";
import type { LoomExtensionPart } from "../loomExtension.ts";
import { LOOM_JOBS_STATUS_KEY } from "@t3tools/provider-pi/server/loom";

const proseOf = (tool: "bg_start" | "bg_wait") => ({
  description: LOOM_TOOL_PROSE[tool].description,
  promptSnippet: LOOM_TOOL_PROSE[tool].promptSnippet,
  promptGuidelines: LOOM_TOOL_PROSE[tool].promptGuidelines.split("\n").filter(Boolean),
});

const BG_START_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      minLength: 1,
      description:
        "The command, run by `bash -c` in the working directory. No trailing `&`, `nohup` or output redirection: the job already runs apart from your turn with its output captured.",
    },
    min_minutes: {
      type: "number",
      minimum: 0,
      description:
        "Your lower bound on the run time, in minutes. An exit before it is reported as early, so you check the output before trusting it.",
    },
    max_minutes: {
      type: "number",
      minimum: 0,
      description:
        "Your upper bound, in minutes. bg_wait waits until here by default, and a job past it is reported as overdue, which is a reason to read its progress, not to stop it.",
    },
  },
  required: ["command", "min_minutes", "max_minutes"],
  additionalProperties: false,
};

const BG_WAIT_PARAMETERS = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, description: "The job id bg_start returned." },
    timeout_s: {
      type: "number",
      minimum: 1,
      description:
        "Seconds to wait before returning with progress if the job has not exited; at most 3600. Omit for the time left before the job's max_minutes (never less than 60 s).",
    },
  },
  required: ["id"],
  additionalProperties: false,
};

const json = JSON.stringify;

export const backgroundJobsPart: LoomExtensionPart = {
  name: "background-jobs",
  source: String.raw`
const cp = process.getBuiltinModule("node:child_process");
const fs = process.getBuiltinModule("node:fs");
const nodePath = process.getBuiltinModule("node:path");
const START = { ...${json(proseOf("bg_start"))}, parameters: ${json(BG_START_PARAMETERS)} };
const WAIT = { ...${json(proseOf("bg_wait"))}, parameters: ${json(BG_WAIT_PARAMETERS)} };
const SUBMIT = ${json(agentToolName("workstream_submit"))};
const STATUS_KEY = ${json(LOOM_JOBS_STATUS_KEY)};
const MESSAGE_TYPE = "loom-bg-job";
const TAIL_LINES = 20;
const MAX_WAIT_S = 3600;

// id -> { id, pid, command, startedAt, minMinutes, maxMinutes, log, exit, reported, lostAt,
//         dir, waiters, lastCheck, lost, woke }; the first ten fields are the on-disk record.
const jobs = new Map();
let ui;
let jobsDir;
let shuttingDown = false;

const code = (text) => "\x60" + text + "\x60";
const text = (body) => ({ content: [{ type: "text", text: body }], details: undefined });
const seconds = (ms) => Math.max(0, Math.round(ms / 1000));
const exact = (ms) => (seconds(ms) < 60 ? seconds(ms) + " s" : Math.floor(seconds(ms) / 60) + " min " + (seconds(ms) % 60) + " s");
const rough = (ms) => (seconds(ms) < 60 ? seconds(ms) + " s" : Math.round(seconds(ms) / 60) + " min");
const bytes = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
const lines = (n, noun = "line") => n + " " + noun + (n === 1 ? "" : "s");
const bounds = (job) => job.minMinutes + " to " + job.maxMinutes + " min";
const against = (job, ms) =>
  ms < job.minMinutes * 60000 ? "before your lower bound of " + job.minMinutes + " min"
  : ms > job.maxMinutes * 60000 ? "past your upper bound of " + job.maxMinutes + " min"
  : "inside your " + bounds(job);
const dirOf = (sm) => nodePath.join(sm.getSessionDir(), "jobs", sm.getSessionId());
const running = () => [...jobs.values()].filter((job) => job.exit === null && !job.lost);

const writeRecord = (job) => {
  const { id, pid, command, startedAt, minMinutes, maxMinutes, log, exit, reported, lostAt } = job;
  fs.writeFileSync(nodePath.join(job.dir, id + ".json"),
    JSON.stringify({ id, pid, command, startedAt, minMinutes, maxMinutes, log, exit, reported, lostAt }));
};
// Fire-and-forget; in RPC mode pi emits it as extension_ui_request { method: "setStatus" }.
const report = (wake) => {
  try { ui?.setStatus?.(STATUS_KEY, JSON.stringify({ running: running().length, ...(wake ? { wake } : {}) })); } catch {}
};

// Line count, size, last write and the last TAIL_LINES lines (a carriage-return progress bar keeps its last frame).
const logStats = (job) => {
  const stats = { size: 0, mtime: job.startedAt, lines: 0, tail: "" };
  let fd;
  try {
    const st = fs.statSync(job.log);
    stats.size = st.size;
    stats.mtime = st.mtimeMs;
    if (st.size === 0) return stats;
    fd = fs.openSync(job.log, "r");
    const buf = Buffer.alloc(1 << 16);
    let last = 10;
    for (let pos = 0, n; (n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0; pos += n) {
      for (let i = buf.indexOf(10); i !== -1 && i < n; i = buf.indexOf(10, i + 1)) stats.lines += 1;
      last = buf[n - 1];
    }
    if (last !== 10) stats.lines += 1;
    const from = Math.max(0, st.size - 32768);
    const tail = Buffer.alloc(st.size - from);
    fs.readSync(fd, tail, 0, tail.length, from);
    const lines = tail.toString("utf8").replace(/\n$/, "").split("\n");
    stats.tail = (from > 0 ? lines.slice(1) : lines).slice(-TAIL_LINES)
      .map((line) => line.slice(line.lastIndexOf("\r") + 1))
      .map((line) => (line.length > 400 ? line.slice(0, 400) + "…" : line))
      .join("\n");
  } catch {
    // An unreadable log reads as empty.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return stats;
};
const tailBlock = (stats) =>
  stats.tail === "" ? "The log is empty." : "Last " + lines(stats.tail.split("\n").length) + ":\n" + stats.tail;

const startText = (job) =>
  "Started job " + job.id + " (pid " + job.pid + "): " + code(job.command) + "\nLog: " + job.log +
  "\nExpected " + bounds(job) + ". bg_wait " + job.id + " returns when it exits; if your turn ends first, its result arrives as a message.";
const ending = (exit) =>
  exit.error ? "could not start (" + exit.error + ")"
  : exit.signal ? "ended by " + exit.signal
  : "finished (exit " + exit.code + ")";
const exitText = (job) => {
  const stats = logStats(job);
  const ms = job.exit.at - job.startedAt;
  return "Background job " + job.id + " " + ending(job.exit) + " after " + exact(ms) + ", " + against(job, ms) + ": " +
    code(job.command) + "\nLog: " + job.log + " (" + lines(stats.lines) + ")\n" + tailBlock(stats);
};
// Growth is measured from the previous bg_wait on the job (or its start); a progress read moves that mark.
const growth = (job, stats, now) => {
  const prior = job.lastCheck ?? { at: job.startedAt, lines: 0, size: 0 };
  return { lines: stats.lines - prior.lines, size: stats.size - prior.size, ago: rough(now - prior.at), first: job.lastCheck === null };
};
const progressText = (job) => {
  const now = Date.now();
  const stats = logStats(job);
  const ms = now - job.startedAt;
  const grew = growth(job, stats, now);
  job.lastCheck = { at: now, lines: stats.lines, size: stats.size };
  const over = ms > job.maxMinutes * 60000;
  return "Job " + job.id + " still running after " + exact(ms) +
    (over ? ", past your upper bound of " + job.maxMinutes + " min" : " (your bounds: " + bounds(job) + ")") +
    ". Log: " + lines(stats.lines) + ", " + bytes(stats.size) + "; +" + lines(grew.lines) + ", +" + bytes(grew.size) +
    (grew.first ? " since it started " : " since your last check ") + grew.ago + " ago; last write " + rough(now - stats.mtime) + " ago.\n" +
    tailBlock(stats);
};
const lostText = (job) =>
  "Background job " + job.id + " (" + code(job.command) + ") was lost when this thread's pi process ended at " +
  new Date(job.lostAt).toTimeString().slice(0, 5) + ", " + rough(job.lostAt - job.startedAt) + " into your " + bounds(job) +
  "; it was not restarted. Its log stops at " + job.log + ".\n" + tailBlock(logStats(job));
const refusal = (live) => {
  const now = Date.now();
  const clauses = live.map((job) => {
    const grew = growth(job, logStats(job), now);
    return "background job " + job.id + " (" + code(job.command) + ") is still running, " + rough(now - job.startedAt) +
      " into your " + bounds(job) + ", with " + lines(grew.lines, "new log line") + " in the last " + grew.ago;
  });
  return "Refused: " + clauses.join("; ") + ". A thread that has submitted cannot act on the job's result, and its wake would start a turn on a finished thread. Wait for it with bg_wait and carry its result in your report, or stop it (" +
    code("kill " + live.map((job) => job.pid).join(" ")) + ") and say so, then submit again.";
};

// pi is going down (Stop, idle release, restart, or a session switch): the open records stay open
// so the next session start reports them lost, and no exit handler may wake.
const abandon = () => {
  shuttingDown = true;
  for (const job of running()) {
    job.lost = true;
    job.lostAt = Date.now();
    try { writeRecord(job); } catch {}
  }
};
let onTerm;

pi.on("session_start", (_event, ext) => {
  shuttingDown = false;
  ui = ext?.ui ?? ui;
  if (onTerm === undefined) process.on("SIGTERM", (onTerm = abandon));
  try {
    jobsDir = dirOf(ext.sessionManager);
    for (const file of fs.readdirSync(jobsDir)) {
      if (!file.endsWith(".json")) continue;
      const known = jobs.get(file.slice(0, -5));
      if (known !== undefined && !known.lost) continue;
      const job = { ...JSON.parse(fs.readFileSync(nodePath.join(jobsDir, file), "utf8")), dir: jobsDir, waiters: new Set(), lastCheck: null };
      job.lost = job.exit === null;
      jobs.set(job.id, job);
      if (!job.lost || job.reported) continue;
      job.lostAt ??= fs.statSync(job.log, { throwIfNoEntry: false })?.mtimeMs ?? job.startedAt;
      job.reported = true;
      writeRecord(job);
      pi.sendMessage({ customType: MESSAGE_TYPE, content: lostText(job), display: true }, { deliverAs: "nextTurn" });
    }
  } catch {
    // No jobs dir yet, or an unreadable record: nothing to report.
  }
  report();
});
pi.on("session_shutdown", () => {
  const live = running();
  abandon();
  for (const job of live) try { process.kill(job.pid, "SIGTERM"); } catch {}
  if (onTerm !== undefined) process.off("SIGTERM", onTerm);
  onTerm = undefined;
  report();
});

const waitFor = (job, ms, signal) => new Promise((resolve, reject) => {
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    job.waiters.delete(done);
    resolve();
  };
  const onAbort = () => {
    clearTimeout(timer);
    job.waiters.delete(done);
    reject(signal.reason ?? new Error("Tool call aborted."));
  };
  const timer = setTimeout(done, ms);
  job.waiters.add(done);
  if (signal?.aborted) return onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
});

pi.registerTool({
  name: "bg_start",
  label: "Background job",
  ...START,
  async execute(_toolCallId, params, _signal, _onUpdate, ext) {
    const { command, min_minutes: minMinutes, max_minutes: maxMinutes } = params;
    if (minMinutes > maxMinutes) throw new Error("min_minutes (" + minMinutes + ") is above max_minutes (" + maxMinutes + ").");
    ui = ext?.ui ?? ui;
    const dir = jobsDir ?? dirOf(ext.sessionManager);
    fs.mkdirSync(dir, { recursive: true });
    let id;
    do id = "j" + Math.random().toString(36).slice(2, 6).padEnd(4, "0");
    while (jobs.has(id) || fs.existsSync(nodePath.join(dir, id + ".json")));
    const log = nodePath.join(dir, id + ".log");
    const fd = fs.openSync(log, "a");
    let child;
    try {
      child = cp.spawn("bash", ["-c", command], { cwd: ext?.cwd ?? process.cwd(), stdio: ["ignore", fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    child.unref();
    const job = { id, pid: child.pid, command, startedAt: Date.now(), minMinutes, maxMinutes, log, exit: null,
      reported: false, lostAt: null, dir, waiters: new Set(), lastCheck: null, lost: false };
    jobs.set(id, job);
    writeRecord(job);
    report();
    // A spawn failure (say, a deleted cwd) arrives as "error" with no "exit"; unhandled, it would
    // crash pi. It settles the job like any other exit.
    const settle = (exitCode, signal, error) => {
      if (shuttingDown || job.lost || job.exit !== null) return;
      job.exit = { code: exitCode, signal, ...(error === undefined ? {} : { error }), at: Date.now() };
      try { writeRecord(job); } catch {}
      if (job.waiters.size > 0) {
        for (const done of [...job.waiters]) done();
        return report();
      }
      const summary = "Background job " + ending(job.exit) + ": " + job.command.replace(/\s+/g, " ").trim().slice(0, 160);
      report({ summary, outcome: exitCode === 0 ? "completed" : "failed" });
      job.woke = true;
      pi.sendMessage({ customType: MESSAGE_TYPE, content: exitText(job), display: true }, { triggerTurn: true });
    };
    child.on("exit", (exitCode, signal) => settle(exitCode, signal));
    child.on("error", (error) => settle(null, null, error?.message ?? String(error)));
    // No pid means the spawn failed and its "error" is on the way: this call reports it, not a wake.
    if (child.pid === undefined) {
      await new Promise((resolve) => job.waiters.add(resolve));
      return text(exitText(job));
    }
    return text(startText(job));
  },
});

pi.registerTool({
  name: "bg_wait",
  label: "Wait for background job",
  ...WAIT,
  async execute(_toolCallId, params, signal) {
    const job = jobs.get(params.id);
    if (job === undefined) throw new Error("No job " + params.id + " in this session.");
    if (job.lost) return text(lostText(job));
    if (job.exit === null) {
      const left = (job.startedAt + job.maxMinutes * 60000 - Date.now()) / 1000;
      await waitFor(job, 1000 * Math.min(MAX_WAIT_S, params.timeout_s ?? Math.max(60, left)), signal);
    }
    // An exit nobody was waiting for already went out as a message (mid-turn it lands after this
    // result): say so rather than deliver the result twice.
    if (job.woke) {
      return text("Background job " + job.id + " " + ending(job.exit) + " after " + exact(job.exit.at - job.startedAt) +
        ", before this call; its exit report was sent to you as a message, which follows this result if you have not seen it yet.");
    }
    return text(job.exit !== null ? exitText(job) : progressText(job));
  },
});

pi.on("tool_call", (event) => {
  try {
    if (event.toolName !== SUBMIT) return undefined;
    const live = running();
    return live.length === 0 ? undefined : { block: true, reason: refusal(live) };
  } catch {
    return undefined;
  }
});
`,
};
