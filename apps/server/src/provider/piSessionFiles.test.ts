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

// pi's `--session-id` resume only opens a file it finds via a PROJECT-scoped
// listing of files that parse as a pi session with a matching header id. Any
// looser predicate reports "resumable" for state pi actually replaces with a
// fresh empty session — the thread then looks alive with its context gone.
describe("resolveResumableSessionFile (what pi will really open)", () => {
  it("accepts a valid session in the project dir for the launch cwd", () => {
    const root = makeRoot();
    const cwd = "/tmp/some/worktree";
    const path = writeSession(piProjectSessionDir(cwd, root), SESSION_ID, {
      body: [JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })],
    });

    expect(resolveResumableSessionFile(SESSION_ID, cwd, root)).toBe(path);
  });

  it("encodes the project dir the way pi does", () => {
    expect(piProjectSessionDir("/home/u/wt", "/root")).toBe(
      NodePath.join("/root", "--home-u-wt--"),
    );
  });

  it("rejects a file whose content is not a pi session (pi would start fresh)", () => {
    const root = makeRoot();
    const cwd = "/tmp/some/worktree";
    const dir = piProjectSessionDir(cwd, root);
    NodeFS.mkdirSync(dir, { recursive: true });
    // The shape the previous filename-only probe wrongly accepted.
    NodeFS.writeFileSync(
      NodePath.join(dir, `2026-07-30T00-00-00-000Z_${SESSION_ID}.jsonl`),
      "{}\n",
    );

    expect(resolveResumableSessionFile(SESSION_ID, cwd, root)).toBeUndefined();
  });

  it("rejects an empty or unreadable file", () => {
    const root = makeRoot();
    const cwd = "/tmp/some/worktree";
    const dir = piProjectSessionDir(cwd, root);
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, `2026-07-30T00-00-00-000Z_${SESSION_ID}.jsonl`), "");

    expect(resolveResumableSessionFile(SESSION_ID, cwd, root)).toBeUndefined();
  });

  it("rejects a session belonging to a DIFFERENT project dir", () => {
    const root = makeRoot();
    // Valid session, but under another worktree's project dir: pi's local lookup
    // never sees it, so it would create a new session with this id instead.
    writeSession(piProjectSessionDir("/tmp/other/worktree", root), SESSION_ID);

    expect(resolveResumableSessionFile(SESSION_ID, "/tmp/some/worktree", root)).toBeUndefined();
  });

  it("rejects a file whose name matches but whose header id does not", () => {
    const root = makeRoot();
    const cwd = "/tmp/some/worktree";
    // pi keys off the HEADER id, never the filename.
    writeSession(piProjectSessionDir(cwd, root), SESSION_ID, { headerId: "a-different-id" });

    expect(resolveResumableSessionFile(SESSION_ID, cwd, root)).toBeUndefined();
  });

  it("returns undefined when the project dir does not exist", () => {
    expect(
      resolveResumableSessionFile(SESSION_ID, "/tmp/never/launched", makeRoot()),
    ).toBeUndefined();
  });

  it("tolerates a leading unparseable line, as pi does", () => {
    const root = makeRoot();
    const cwd = "/tmp/some/worktree";
    const dir = piProjectSessionDir(cwd, root);
    NodeFS.mkdirSync(dir, { recursive: true });
    const path = NodePath.join(dir, `2026-07-30T00-00-00-000Z_${SESSION_ID}.jsonl`);
    const header = JSON.stringify({ type: "session", id: SESSION_ID, timestamp: "2026-07-30" });
    NodeFS.writeFileSync(path, `not json\n${header}\n`);

    expect(resolveResumableSessionFile(SESSION_ID, cwd, root)).toBe(path);
  });
});
