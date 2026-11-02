// @effect-diagnostics nodeBuiltinImport:off
/**
 * Launch provenance for the evals dashboard (plans/loom-evals §2.2): the commit and the
 * instruction files that composed a thread's prompt, as hashes, since the prompt-debug sidecar
 * holding the text is pruned after 30 days.
 */
import type { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { LoomLaunchStamp } from "../projection/LoomStore.ts";
import type { LaunchIdentityRecord } from "../workstream/launchIdentity.ts";
import { LOOM_REPO_ROOT, roleFiles } from "./roleOverlay.ts";

const sha256 = (parts: ReadonlyArray<string | Buffer>) =>
  parts.reduce((hash, part) => hash.update(part), NodeCrypto.createHash("sha256")).digest("hex");

const fileSha = (path: string | null) =>
  path !== null && NodeFS.existsSync(path) ? sha256([NodeFS.readFileSync(path)]) : null;

let loomCommit: string | undefined;

/** Synchronous file reads and one cached `git rev-parse`: the caller wraps it and ignores a failure. */
export const launchStamp = (input: {
  readonly threadId: ThreadId;
  readonly launchedAt: IsoDateTime;
  readonly role: string | null;
  readonly projectRoot: string;
  readonly identity: LaunchIdentityRecord;
}): LoomLaunchStamp => {
  loomCommit ??= NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: LOOM_REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const role = roleFiles({ role: input.role, projectRoot: input.projectRoot });
  const skills = input.identity.skills.toSorted();
  return {
    thread_id: input.threadId,
    launched_at: input.launchedAt,
    loom_commit: loomCommit,
    role: input.role,
    role_sha: fileSha(role.builtin),
    project_role_sha: fileSha(role.project),
    skills_sha:
      skills.length === 0
        ? null
        : sha256(
            // A skill path names its directory or its SKILL.md; the SKILL.md is what pi loads.
            skills.flatMap((path) => [
              path,
              fileSha(path.endsWith(".md") ? path : NodePath.join(path, "SKILL.md")) ?? "missing",
            ]),
          ),
    agents_global_sha: fileSha(NodePath.join(NodeOS.homedir(), ".pi", "agent", "AGENTS.md")),
    agents_project_sha: fileSha(NodePath.join(input.projectRoot, "AGENTS.md")),
    prompt_sha: sha256([input.identity.appendSystemPrompt]),
    skill_paths: skills.length === 0 ? null : JSON.stringify(skills),
  };
};
