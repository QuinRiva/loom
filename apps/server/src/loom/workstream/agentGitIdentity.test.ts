// @effect-diagnostics nodeBuiltinImport:off - drives the real shim and the real git in a temp repo.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { agentGitEnv, materializeGitShim } from "./agentGitIdentity.ts";

it.effect("the git shim signs agent commits with their thread and session, and nothing else", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "loom-git-shim-"));
    const shimDir = yield* materializeGitShim(NodePath.join(root, "bin"));
    const repo = NodePath.join(root, "repo");
    NodeFS.mkdirSync(repo);
    const env = (ids: boolean) => ({
      PATH: `${shimDir}:${process.env.PATH}`,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      ...(ids
        ? { ...agentGitEnv(ThreadId.make("thread:shim-test")), PI_SESSION_ID: "session-1" }
        : {}),
    });
    // `git` resolves through PATH, so every call goes through the shim.
    const git = (args: ReadonlyArray<string>, ids = true, cwd = repo) =>
      NodeChildProcess.execFileSync("git", args, { cwd, env: env(ids), encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "human@example.com"]);
    git(["config", "user.name", "The Human"]);
    const lastCommit = () => git(["log", "-1", "--format=%an <%ae> | %cn%n%B"]).trim();
    const SIGNED = "Loom-Thread: thread:shim-test\nPi-Session: session-1";

    NodeFS.writeFileSync(NodePath.join(repo, "a"), "a");
    git(["add", "a"]);
    git(["commit", "-q", "-m", "first"]);
    assert.equal(lastCommit(), `Loom agent <human@example.com> | Loom agent\nfirst\n\n${SIGNED}`);

    // Global options before the subcommand, a pathspec after `--`: the trailers land on `commit`.
    NodeFS.writeFileSync(NodePath.join(repo, "b"), "b");
    NodeFS.writeFileSync(NodePath.join(repo, "c"), "c");
    git(["add", "b", "c"]);
    git(
      ["-C", repo, "-c", "core.quotepath=false", "commit", "-q", "-m", "second", "--", "b"],
      true,
      root,
    );
    assert.equal(lastCommit(), `Loom agent <human@example.com> | Loom agent\nsecond\n\n${SIGNED}`);
    assert.equal(git(["status", "--porcelain"]).trim(), "A  c");

    // An amend keeps one copy of each trailer.
    git(["commit", "-q", "--amend", "--no-edit"]);
    assert.equal(lastCommit(), `Loom agent <human@example.com> | Loom agent\nsecond\n\n${SIGNED}`);

    // Outside a Loom session the shim adds nothing.
    git(["commit", "-q", "--allow-empty", "-m", "by hand"], false);
    assert.equal(lastCommit(), "The Human <human@example.com> | The Human\nby hand");
  }).pipe(Effect.provide(NodeServices.layer)),
);
