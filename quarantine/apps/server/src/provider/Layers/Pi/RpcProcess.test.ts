import * as NodeStream from "node:stream";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { attachStdoutLineReader, buildPiRpcArgs, setPauseAwareTimeout } from "./RpcProcess.ts";

describe("buildPiRpcArgs", () => {
  // `--tools` is the consult fork's read-only SANDBOX (pi filters its tool
  // registries by it at launch), never a role profile — role profiles are an
  // active-set selection carried in T3_ACTIVE_TOOLS, so dormant families stay
  // registered and enable_toolset can activate them.
  it("emits a repeated --skill pair per skill path, after any --tools allowlist", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      sessionId: "thread-session",
      tools: ["read", "grep"],
      skills: ["/abs/skills/mdx-visual-plan", "/abs/skills/other"],
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--tools",
        "read,grep",
        "--skill",
        "/abs/skills/mdx-visual-plan",
        "--skill",
        "/abs/skills/other",
      ]),
    );
    expect(args.filter((arg) => arg === "--skill")).toHaveLength(2);
  });

  it("omits --skill and --tools entirely when neither option is set", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      sessionId: "thread-session",
    });
    expect(args).not.toContain("--skill");
    expect(args).not.toContain("--tools");
  });

  // Thread fork: the driver's first-launch guard passes `forkFrom` (the source
  // session), which must serialise to `--fork <src>` BEFORE the child's own
  // `--session-id` — pi forks the source into the fresh id.
  it("emits --fork <source> before --session-id when forkFrom is set", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      sessionId: "child-session",
      forkFrom: "/abs/sessions/proj/2026_source-session.jsonl",
    });
    const forkIdx = args.indexOf("--fork");
    const sessionIdx = args.indexOf("--session-id");
    expect(forkIdx).toBeGreaterThanOrEqual(0);
    expect(args[forkIdx + 1]).toBe("/abs/sessions/proj/2026_source-session.jsonl");
    expect(sessionIdx).toBeGreaterThan(forkIdx);
  });

  // Every non-first launch (resume) omits forkFrom, so no `--fork` is emitted
  // and pi create-or-resumes the child's own session file normally.
  it("omits --fork when forkFrom is not set", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      sessionId: "child-session",
    });
    expect(args).not.toContain("--fork");
  });

  // Post-completion engagement (plan §4.2) — CAPABILITY: resume never spawns a
  // same-id sibling session. A resume names the EXISTING session file by path
  // (`--session <file>`) with the canonical cwd pinned (`--cwd <dir>`), and must
  // NOT re-declare `--session-id` — launching `--session-id` from a relocated cwd
  // silently creates an empty same-id session (the amnesia mode, plan fact 2).
  it("resumes by --session <file> --cwd <dir> and never emits --session-id", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      // A resume carries BOTH the deterministic id (for reference) and the
      // resolved file path; the file path wins.
      sessionId: "thread-session",
      sessionFilePath: "/abs/sessions/proj/2026_thread-session.jsonl",
      cwdOverride: "/abs/parent-worktree",
    });
    const sessionIdx = args.indexOf("--session");
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(args[sessionIdx + 1]).toBe("/abs/sessions/proj/2026_thread-session.jsonl");
    const cwdIdx = args.indexOf("--cwd");
    expect(cwdIdx).toBeGreaterThanOrEqual(0);
    expect(args[cwdIdx + 1]).toBe("/abs/parent-worktree");
    // The silent-amnesia guard: no `--session-id` on a resume.
    expect(args).not.toContain("--session-id");
  });
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const readLines = async (chunks: ReadonlyArray<string | Buffer>) => {
  const stream = new NodeStream.PassThrough();
  const lines: string[] = [];
  attachStdoutLineReader(stream, (line) => {
    lines.push(line);
  });
  const ended = new Promise((resolve) => stream.once("end", resolve));
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await ended;
  return lines;
};

describe("attachStdoutLineReader", () => {
  it("reassembles a line split across many chunks", async () => {
    const line = JSON.stringify({ type: "message_update", text: "hello world" });
    expect(await readLines([...`${line}\n`])).toEqual([line]);
  });

  it("splits multiple lines per chunk, trims \\r and skips blank lines", async () => {
    expect(await readLines(["a\r\nb\n\n", "c\r\n"])).toEqual(["a", "b", "c"]);
  });

  it("handles a line larger than 1 MB", async () => {
    const big = "x".repeat(1_500_000);
    const chunks = Array.from({ length: 24 }, (_, index) =>
      big.slice(index * 65_536, (index + 1) * 65_536),
    );
    expect(await readLines([...chunks, "\nnext\n"])).toEqual([big, "next"]);
  });

  it("decodes a multi-byte UTF-8 character split across chunks", async () => {
    const bytes = Buffer.from("héllo 🌏\n", "utf8");
    const splitInsideEmoji = bytes.indexOf(0xf0) + 2;
    expect(
      await readLines([
        bytes.subarray(0, 2),
        bytes.subarray(2, splitInsideEmoji),
        bytes.subarray(splitInsideEmoji),
      ]),
    ).toEqual(["héllo 🌏"]);
  });

  it("flushes an unterminated tail at end of stream", async () => {
    expect(await readLines(["first\nlast"])).toEqual(["first", "last"]);
  });

  it("pauses at 16 open listener promises and resumes at 4", async () => {
    const stream = new NodeStream.PassThrough();
    const open: Array<() => void> = [];
    const reader = attachStdoutLineReader(
      stream,
      () => new Promise<void>((resolve) => open.push(resolve)),
    );

    stream.write("x\n".repeat(15));
    await flush();
    expect(stream.isPaused()).toBe(false);
    stream.write("x\n");
    await flush();
    expect(open).toHaveLength(16);
    expect(stream.isPaused()).toBe(true);
    expect(reader.isPaused()).toBe(true);

    stream.write("held\n");
    await flush();
    expect(open).toHaveLength(16);

    for (const settle of open.splice(0, 11)) settle();
    await flush();
    expect(stream.isPaused()).toBe(true);

    open.shift()!();
    await flush();
    expect(stream.isPaused()).toBe(false);
    expect(reader.pauseCount()).toBe(1);
    expect(open).toHaveLength(5);
  });
});

describe("setPauseAwareTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-arms while stdout is paused and rejects once it has not been", () => {
    vi.useFakeTimers();
    const stdout = { paused: true, pauses: 1 };
    const onTimeout = vi.fn();
    setPauseAwareTimeout(
      { isPaused: () => stdout.paused, pauseCount: () => stdout.pauses },
      1_000,
      onTimeout,
    );
    vi.advanceTimersByTime(3_000);
    expect(onTimeout).not.toHaveBeenCalled();

    // Resumed, then paused and resumed again within one window: still re-arms.
    stdout.paused = false;
    stdout.pauses = 2;
    vi.advanceTimersByTime(1_000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("stops re-arming after the cap and times out as usual", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    setPauseAwareTimeout({ isPaused: () => true, pauseCount: () => 1 }, 1_000, onTimeout, 3);
    vi.advanceTimersByTime(3_999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("times out on schedule when stdout is never paused", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const cancel = setPauseAwareTimeout(
      { isPaused: () => false, pauseCount: () => 0 },
      1_000,
      onTimeout,
    );
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    cancel();
  });
});
