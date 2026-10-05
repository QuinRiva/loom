// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
/**
 * Contract test for Loom's pi patch 0001
 * (`infra/pi-patches/0001-pi-cwd-override-rpc-resume.patch`), run against the
 * bundled `bin.pi` (`dist/bundle/cli.js`) — the binary every Loom pi spawn runs.
 *
 * Loom reaps a completed sub-thread's worktree, so resuming that thread must
 * reopen the SAME session file somewhere else. Two pi behaviours make that
 * delicate, and both are pinned here, on both resume paths the patch covers:
 *
 *  - the CLI `--session <file> --cwd <dir>` launch (a human reopening a session
 *    from a terminal);
 *  - the RPC `switch_session { sessionPath, cwdOverride }` command, which is how
 *    `PiAdapterV2` resumes a provider thread.
 *
 * Without the override pi welds the session to its recorded cwd: a resumed
 * runtime runs its tools there, and a missing one is a hard error. With it the
 * header is never rewritten and the conversation continues by append.
 *
 * Everything is asserted from RPC responses and the filesystem: no model calls.
 * pi is a workspace dependency, so the test never skips: an unresolvable or
 * unpatched bundle fails it — exactly the upstream drift we want to hear about.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { resolveBundledPiCliPath } from "./bundledPi.loom.ts";

const RPC_TIMEOUT_MS = 45_000;
const SESSION_ID = "019fb200-0000-7000-8000-00000000abcd";

const cliPath = resolveBundledPiCliPath();

const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-cwd-override-"));
afterAll(() => {
  NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
});

interface Fixture {
  /** Session file whose header cwd points at a directory that does not exist. */
  readonly sessionFile: string;
  /** Explicit `--session-dir`, so the test never touches the real session store. */
  readonly sessionDir: string;
  /** An existing directory to relocate the resume into. */
  readonly liveCwd: string;
  /** The dead directory named in the header. */
  readonly deadCwd: string;
  readonly originalLines: ReadonlyArray<string>;
}

let fixtureSeq = 0;

/** A minimal but valid pi session: header plus one user/assistant pair. */
function createDeadCwdSession(): Fixture {
  const caseDir = NodePath.join(tmpRoot, `case-${++fixtureSeq}`);
  const sessionDir = NodePath.join(caseDir, "sessions");
  const liveCwd = NodePath.join(caseDir, "live");
  const deadCwd = NodePath.join(caseDir, "reaped-worktree");
  NodeFS.mkdirSync(sessionDir, { recursive: true });
  NodeFS.mkdirSync(liveCwd, { recursive: true });
  expect(NodeFS.existsSync(deadCwd)).toBe(false);

  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: SESSION_ID,
      timestamp: "2026-07-30T00:00:00.000Z",
      cwd: deadCwd,
    }),
    JSON.stringify({
      type: "message",
      id: "aaaaaaa1",
      parentId: null,
      timestamp: "2026-07-30T00:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "The magic token is ZARQUON-77." }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "aaaaaaa2",
      parentId: "aaaaaaa1",
      timestamp: "2026-07-30T00:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Noted: ZARQUON-77." }] },
    }),
  ];
  const sessionFile = NodePath.join(sessionDir, `2026-07-30T00-00-00-000Z_${SESSION_ID}.jsonl`);
  NodeFS.writeFileSync(sessionFile, `${lines.join("\n")}\n`);
  return { sessionFile, sessionDir, liveCwd, deadCwd, originalLines: lines };
}

interface RpcRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the bundled pi in RPC mode from `cwd` and feed `commands` one at a time:
 * pi handles stdin lines concurrently, so each command is written only after the
 * previous one's response arrives. Extensions are disabled (`-ne`) so the run
 * depends on nothing but pi itself. stdin is closed after the last response,
 * because closing it makes pi shut down — which would race a command in flight.
 */
function runPiRpc(input: {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly commands?: ReadonlyArray<unknown>;
}): Promise<RpcRun> {
  if (cliPath === undefined) {
    throw new Error("the bundled pi (@earendil-works/pi-coding-agent bin.pi) did not resolve");
  }
  const commands = [...(input.commands ?? [])];
  const child = NodeChildProcess.spawn(cliPath, ["--mode", "rpc", "-ne", ...input.args], {
    cwd: input.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise<RpcRun>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi RPC timed out after ${RPC_TIMEOUT_MS}ms\n${stdout}\n${stderr}`));
    }, RPC_TIMEOUT_MS);
    const writeNext = () => {
      const command = commands.shift();
      if (command === undefined) child.stdin.end();
      else child.stdin.write(`${JSON.stringify(command)}\n`);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let seen = 0;
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split("\n").slice(0, -1);
      for (const line of lines.slice(seen)) if (line.includes('"type":"response"')) writeNext();
      seen = lines.length;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });

    child.stdin.on("error", () => {
      // pi may exit (e.g. a usage error) before the commands are written.
    });
    writeNext();
  });
}

function responseFor(run: RpcRun, command: string): Record<string, unknown> | undefined {
  for (const line of run.stdout.split("\n")) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed["type"] === "response" && parsed["command"] === command) return parsed;
  }
  return undefined;
}

function sessionFilesFor(sessionDir: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(sessionDir).filter((name) => name.includes(SESSION_ID));
}

describe("pi --cwd (CLI headless resume of a session whose cwd was deleted)", () => {
  it("resumes the original session file in the override cwd, with history intact", async () => {
    const fixture = createDeadCwdSession();
    const run = await runPiRpc({
      // Deliberately launched from somewhere unrelated to both the header cwd
      // and the override: only --session/--cwd may decide the outcome.
      cwd: tmpRoot,
      args: [
        "--session-dir",
        fixture.sessionDir,
        "--session",
        fixture.sessionFile,
        "--cwd",
        fixture.liveCwd,
      ],
      commands: [{ id: "1", type: "get_state" }],
    });

    expect(run.status, `pi exited unexpectedly:\n${run.stderr}`).toBe(0);
    const state = responseFor(run, "get_state");
    expect(state?.["success"], `no successful get_state:\n${run.stdout}\n${run.stderr}`).toBe(true);
    const data = state?.["data"] as Record<string, unknown>;

    // Same conversation: same file, same id, and the two crafted messages are
    // loaded (an amnesiac new session would report 0).
    expect(data["sessionFile"]).toBe(fixture.sessionFile);
    expect(data["sessionId"]).toBe(SESSION_ID);
    expect(data["messageCount"]).toBe(2);

    // No sibling session file appeared for this id.
    expect(sessionFilesFor(fixture.sessionDir)).toHaveLength(1);

    // The file was appended to, never rewritten: the crafted lines (header cwd
    // included) survive verbatim as the historical record.
    const lines = NodeFS.readFileSync(fixture.sessionFile, "utf8").split("\n").filter(Boolean);
    expect(lines.slice(0, fixture.originalLines.length)).toEqual([...fixture.originalLines]);
    expect(lines[0]).toContain(fixture.deadCwd);
  });

  it("makes the override the working directory the session actually runs in", async () => {
    const fixture = createDeadCwdSession();
    const run = await runPiRpc({
      cwd: tmpRoot,
      args: [
        "--session-dir",
        fixture.sessionDir,
        "--session",
        fixture.sessionFile,
        "--cwd",
        fixture.liveCwd,
      ],
      commands: [{ id: "1", type: "bash", command: "pwd" }],
    });

    expect(run.status, run.stderr).toBe(0);
    const bash = responseFor(run, "bash");
    expect(bash?.["success"], `${run.stdout}\n${run.stderr}`).toBe(true);
    const data = bash?.["data"] as { readonly output?: string };
    expect(data.output?.trim()).toBe(NodeFS.realpathSync(fixture.liveCwd));
  });

  it("still hard-exits on a missing session cwd when --cwd is absent", async () => {
    const fixture = createDeadCwdSession();
    const run = await runPiRpc({
      cwd: fixture.liveCwd,
      args: ["--session-dir", fixture.sessionDir, "--session", fixture.sessionFile],
      commands: [{ id: "1", type: "get_state" }],
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Stored session working directory does not exist");
    expect(run.stderr).toContain(fixture.deadCwd);
    // The failed launch must not have created a replacement session either.
    expect(sessionFilesFor(fixture.sessionDir)).toHaveLength(1);
  });

  it("rejects --cwd without --session", async () => {
    const fixture = createDeadCwdSession();
    const run = await runPiRpc({
      cwd: tmpRoot,
      args: ["--session-dir", fixture.sessionDir, "--cwd", fixture.liveCwd],
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--cwd requires --session");
  });

  it("rejects --cwd pointing at a directory that does not exist", async () => {
    const fixture = createDeadCwdSession();
    const missing = NodePath.join(fixture.liveCwd, "nope");
    const run = await runPiRpc({
      cwd: tmpRoot,
      args: [
        "--session-dir",
        fixture.sessionDir,
        "--session",
        fixture.sessionFile,
        "--cwd",
        missing,
      ],
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--cwd directory does not exist");
  });

  it("rejects --cwd combined with --session-id, which may create a session", async () => {
    const fixture = createDeadCwdSession();
    const run = await runPiRpc({
      cwd: tmpRoot,
      args: [
        "--session-dir",
        fixture.sessionDir,
        "--session-id",
        SESSION_ID,
        "--cwd",
        fixture.liveCwd,
      ],
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--cwd cannot be combined with --session-id");
  });
});

describe("pi RPC switch_session cwdOverride (how PiAdapterV2 resumes a provider thread)", () => {
  /** pi starts a fresh, empty session here; only switch_session may move it. */
  const startupDir = (fixture: Fixture) => {
    const dir = NodePath.join(NodePath.dirname(fixture.sessionDir), "startup");
    NodeFS.mkdirSync(dir, { recursive: true });
    return dir;
  };

  it("resumes with cwdOverride: history intact, tools run in the override", async () => {
    const fixture = createDeadCwdSession();
    const run = await runPiRpc({
      cwd: startupDir(fixture),
      args: ["--session-dir", fixture.sessionDir],
      commands: [
        {
          id: "1",
          type: "switch_session",
          sessionPath: fixture.sessionFile,
          cwdOverride: fixture.liveCwd,
        },
        { id: "2", type: "get_state" },
        { id: "3", type: "bash", command: "pwd" },
      ],
    });

    expect(run.status, run.stderr).toBe(0);
    const switched = responseFor(run, "switch_session");
    expect(switched?.["success"], `${run.stdout}\n${run.stderr}`).toBe(true);
    expect(switched?.["data"]).toEqual({ cancelled: false });

    // Same conversation: same file, same id, both crafted messages loaded (an
    // amnesiac new session would report 0).
    const state = responseFor(run, "get_state")?.["data"] as Record<string, unknown>;
    expect(state["sessionFile"]).toBe(fixture.sessionFile);
    expect(state["sessionId"]).toBe(SESSION_ID);
    expect(state["messageCount"]).toBe(2);
    // pi persists no file for the empty startup session, and none was created for this id.
    expect(sessionFilesFor(fixture.sessionDir)).toHaveLength(1);

    // Appended to, never rewritten: the header still records the dead cwd.
    const lines = NodeFS.readFileSync(fixture.sessionFile, "utf8").split("\n").filter(Boolean);
    expect(lines.slice(0, fixture.originalLines.length)).toEqual([...fixture.originalLines]);
    expect(lines[0]).toContain(fixture.deadCwd);

    const bash = responseFor(run, "bash");
    expect(bash?.["success"], `${run.stdout}\n${run.stderr}`).toBe(true);
    const output = (bash?.["data"] as { readonly output?: string } | undefined)?.output;
    expect(output?.trim()).toBe(NodeFS.realpathSync(fixture.liveCwd));
  });

  it("still refuses a dead recorded cwd without cwdOverride, and stays up", async () => {
    const fixture = createDeadCwdSession();
    const run = await runPiRpc({
      cwd: startupDir(fixture),
      args: ["--session-dir", fixture.sessionDir],
      commands: [
        { id: "1", type: "switch_session", sessionPath: fixture.sessionFile },
        { id: "2", type: "get_state" },
      ],
    });

    expect(run.status, run.stderr).toBe(0);
    const switched = responseFor(run, "switch_session");
    expect(switched?.["success"]).toBe(false);
    expect(switched?.["error"]).toContain("Stored session working directory does not exist");
    expect(switched?.["error"]).toContain(fixture.deadCwd);

    // The process is alive and still on its startup session; the fixture is untouched.
    const state = responseFor(run, "get_state");
    expect(state?.["success"]).toBe(true);
    expect((state?.["data"] as Record<string, unknown> | undefined)?.["sessionFile"]).not.toBe(
      fixture.sessionFile,
    );
    expect(NodeFS.readFileSync(fixture.sessionFile, "utf8")).toBe(
      `${fixture.originalLines.join("\n")}\n`,
    );
  });

  it("rejects a cwdOverride that is not a directory, and stays up", async () => {
    const fixture = createDeadCwdSession();
    const missing = NodePath.join(fixture.liveCwd, "nope");
    const run = await runPiRpc({
      cwd: startupDir(fixture),
      args: ["--session-dir", fixture.sessionDir],
      commands: [
        {
          id: "1",
          type: "switch_session",
          sessionPath: fixture.sessionFile,
          cwdOverride: missing,
        },
        { id: "2", type: "get_state" },
      ],
    });

    expect(run.status, run.stderr).toBe(0);
    const switched = responseFor(run, "switch_session");
    expect(switched?.["success"]).toBe(false);
    expect(switched?.["error"]).toContain(`cwdOverride directory does not exist: ${missing}`);

    const state = responseFor(run, "get_state");
    expect(state?.["success"]).toBe(true);
    expect((state?.["data"] as Record<string, unknown> | undefined)?.["sessionFile"]).not.toBe(
      fixture.sessionFile,
    );
  });
});
