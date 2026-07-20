// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Who may merge a PR to the project's main branch. The default is `"human"`: a
 * project opts INTO agent-merge via `.t3code/ship.json`, so a repo with no
 * policy is never agent-merged by accident — the PE-2111 failure mode, where
 * merge-authority lived only as an assumption in a brief chain and got dropped.
 */
export type MergeAuthority = "agent" | "human";

/**
 * Walk up from `cwd` for the nearest `.t3code/ship.json`
 * (`{ "merge": { "authority": "agent" | "human" } }`). Missing, unreadable, or
 * invalid → `"human"`; never throws, so a broken config can only make shipping
 * more conservative.
 */
export function resolveMergeAuthority(cwd: string): MergeAuthority {
  for (let dir = NodePath.resolve(cwd); ; ) {
    let raw: string | undefined;
    try {
      raw = NodeFS.readFileSync(NodePath.join(dir, ".t3code", "ship.json"), "utf8");
    } catch {
      raw = undefined;
    }
    if (raw !== undefined) {
      try {
        const authority = (JSON.parse(raw) as { merge?: { authority?: unknown } }).merge?.authority;
        return authority === "agent" ? "agent" : "human";
      } catch {
        return "human";
      }
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) return "human";
    dir = parent;
  }
}

/** The SHIPPING POLICY block stating the merge contract to every thread — the
 * in-band guidance that counters a "done = merged" norm inherited from a brief. */
export function shipPolicyPromptBlock(authority: MergeAuthority): string {
  return authority === "agent"
    ? "SHIPPING POLICY: merge authority is AGENT-OK — an agent may merge to the main branch once the work is approved and required checks pass, then clean up the branch."
    : "SHIPPING POLICY: merge authority is HUMAN-ONLY. Agents must NOT merge to the main branch. The agent ceiling is an open, review-ready PR (and moving any tracker card to In Review); then stop and hand back the PR URL for a human to review and merge — even if a brief's definition of done says the work is 'done when merged'. Never run `gh pr merge` (or any merge) yourself.";
}
