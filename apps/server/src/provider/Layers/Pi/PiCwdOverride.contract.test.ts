// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
/**
 * Contract test for the local pi patch that exposes `--cwd <dir>` on the
 * headless/RPC resume path (`infra/pi-patches/0001-pi-cwd-override-rpc-resume.patch`).
 *
 * Loom deletes a completed sub-thread's worktree after fan-in, so re-engaging
 * that thread must resume the SAME session file from a different directory. Two
 * pi behaviours make that delicate, and both are pinned here:
 *
 *  - the session directory is derived from the launch cwd's slug, so resuming
 *    from the wrong place silently creates a NEW empty session with the same id
 *    (amnesia, not an error) — asserted against by counting files and the
 *    reported messageCount;
 *  - the header cwd must exist or RPC startup hard-exits — asserted as the
 *    unchanged default, and as satisfied when `--cwd` is passed.
 *
 * Everything is asserted from RPC responses and the filesystem: no model calls.
 * Skips when pi is not installed; fails loudly when pi is installed but
 * unpatched, since that is exactly the upstream drift we want to hear about.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { resolvePiInvocation } from "./Cli.ts";

const RPC_TIMEOUT_MS = 45_000;
const SESSION_ID = "019fb200-0000-7000-8000-00000000abcd";

const invocation = resolvePiInvocation("pi");
const piAvailable = (() => {
  if (invocation.args.length > 0) return NodeFS.existsSync(invocation.args[0]!);
  const probe = NodeChildProcess.spawnSync(invocation.command, ["--version"], { timeout: 20_000 });
  return probe.status === 0;
})();

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
 * Run pi in RPC mode from `cwd`, feed the given commands on stdin, and collect
 * the transcript. Extensions are disabled (`-ne`) so the run depends on nothing
 * but pi itself. stdin is held open until every expected response has arrived,
 * because closing it makes pi shut down immediately — which would race a
 * command still in flight.
 */
function runPiRpc(input: {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly commands?: ReadonlyArray<unknown>;
}): Promise<RpcRun> {
  const commands = input.commands ?? [];
  const child = NodeChildProcess.spawn(
    invocation.command,
    [...invocation.args, "--mode", "rpc", "-ne", ...input.args],
    { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"] },
  );

  return new Promise<RpcRun>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let responses = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi RPC timed out after ${RPC_TIMEOUT_MS}ms\n${stdout}\n${stderr}`));
    }, RPC_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      responses += chunk.split("\n").filter((line) => line.includes('"type":"response"')).length;
      if (responses >= commands.length) child.stdin.end();
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
    for (const command of commands) child.stdin.write(`${JSON.stringify(command)}\n`);
    if (commands.length === 0) child.stdin.end();
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

const describeIfPi = piAvailable ? describe : describe.skip;

describeIfPi("pi --cwd (headless resume of a session whose cwd was deleted)", () => {
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
