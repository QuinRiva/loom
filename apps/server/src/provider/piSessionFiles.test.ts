// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { piProjectSessionDir, resolveResumableSessionFile } from "./piSessionFiles.ts";

const SESSION_ID = "44444444-0000-4000-8000-000000000004";

const makeRoot = (): string =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-resumable-root-"));

/** A valid pi session file: first parseable line is a `session` header. */
const writeSession = (
  dir: string,
  sessionId: string,
  options?: { readonly headerId?: string; readonly body?: ReadonlyArray<string> },
): string => {
  NodeFS.mkdirSync(dir, { recursive: true });
  const path = NodePath.join(dir, `2026-07-30T00-00-00-000Z_${sessionId}.jsonl`);
  const header = JSON.stringify({
    type: "session",
    id: options?.headerId ?? sessionId,
    timestamp: "2026-07-30T00:00:00.000Z",
    cwd: "/tmp/project",
  });
  NodeFS.writeFileSync(path, [header, ...(options?.body ?? [])].join("\n") + "\n");
  return path;
};

// A pi resume is `--session <path> --cwd <dir>`: pi opens the named path
// outright, so the file's project dir is irrelevant, but pi also skips its own
// header read and would silently open a non-session file as an EMPTY
// conversation. The probe therefore scopes exactly as the launch does (global,
// by name) and validates exactly what the launch cannot (the header).
describe("resolveResumableSessionFile (what a resume will really open)", () => {
  it("accepts a valid session in the project dir for the launch cwd", () => {
    const root = makeRoot();
    const path = writeSession(piProjectSessionDir("/tmp/some/worktree", root), SESSION_ID, {
      body: [JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })],
    });

    expect(resolveResumableSessionFile(SESSION_ID, root)).toBe(path);
  });

  it("encodes the project dir the way pi does", () => {
    expect(piProjectSessionDir("/home/u/wt", "/root")).toBe(
      NodePath.join("/root", "--home-u-wt--"),
    );
  });

  // The relocated-worktree case the `--cwd` patch exists for: loom deletes a
  // completed sub-thread's worktree at fan-in, so the session file stays under
  // the DEAD worktree's project dir while the resume launches from elsewhere.
  // `--session <path>` opens it regardless, so refusing here would strand a
  // thread that is genuinely recoverable.
  it("accepts a session under ANOTHER project dir (the relocated-worktree resume)", () => {
    const root = makeRoot();
    const path = writeSession(piProjectSessionDir("/tmp/reaped/worktree", root), SESSION_ID, {
      body: [JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })],
    });

    expect(resolveResumableSessionFile(SESSION_ID, root)).toBe(path);
  });

  it("rejects a file whose content is not a pi session (resume would open it empty)", () => {
    const root = makeRoot();
    const dir = piProjectSessionDir("/tmp/some/worktree", root);
    NodeFS.mkdirSync(dir, { recursive: true });
    // The shape a filename-only probe wrongly accepts.
    NodeFS.writeFileSync(
      NodePath.join(dir, `2026-07-30T00-00-00-000Z_${SESSION_ID}.jsonl`),
      "{}\n",
    );

    expect(resolveResumableSessionFile(SESSION_ID, root)).toBeUndefined();
  });

  it("rejects an empty or unreadable file", () => {
    const root = makeRoot();
    const dir = piProjectSessionDir("/tmp/some/worktree", root);
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, `2026-07-30T00-00-00-000Z_${SESSION_ID}.jsonl`), "");

    expect(resolveResumableSessionFile(SESSION_ID, root)).toBeUndefined();
  });

  it("rejects a file whose name matches but whose header id does not", () => {
    const root = makeRoot();
    // A session copied/renamed under this thread's filename still belongs to
    // another conversation; resuming it would splice foreign history in.
    writeSession(piProjectSessionDir("/tmp/some/worktree", root), SESSION_ID, {
      headerId: "a-different-id",
    });

    expect(resolveResumableSessionFile(SESSION_ID, root)).toBeUndefined();
  });

  it("returns undefined when nothing was ever launched for this id", () => {
    expect(resolveResumableSessionFile(SESSION_ID, makeRoot())).toBeUndefined();
  });

  it("tolerates a leading unparseable line, as pi does", () => {
    const root = makeRoot();
    const dir = piProjectSessionDir("/tmp/some/worktree", root);
    NodeFS.mkdirSync(dir, { recursive: true });
    const path = NodePath.join(dir, `2026-07-30T00-00-00-000Z_${SESSION_ID}.jsonl`);
    const header = JSON.stringify({ type: "session", id: SESSION_ID, timestamp: "2026-07-30" });
    NodeFS.writeFileSync(path, `not json\n${header}\n`);

    expect(resolveResumableSessionFile(SESSION_ID, root)).toBe(path);
  });
});
