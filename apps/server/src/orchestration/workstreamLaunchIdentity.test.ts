// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  deleteLaunchIdentity,
  isKickoffDelivered,
  kickoffDeliveredMarkerPath,
  launchIdentityPath,
  markKickoffDelivered,
  readLaunchIdentity,
  resolveForkLaunchArgs,
  updateLaunchIdentityApplied,
  writeLaunchIdentity,
  type LaunchIdentityRecord,
} from "./workstreamLaunchIdentity.ts";
import { buildPiRpcArgs } from "../provider/Layers/Pi/RpcProcess.ts";

const A = ThreadId.make("11111111-1111-1111-1111-111111111111");
const B = ThreadId.make("22222222-2222-2222-2222-222222222222");

const baseRecord: LaunchIdentityRecord = {
  providerInstanceId: "google-vertex",
  model: "google-vertex-claude/claude-opus-4-8",
  options: [{ id: "thinkingLevel", value: "high" }],
  // The FINAL argv bytes: the work-model prompt has already been prepended, so a
  // fork replaying this must not prepend it again.
  appendSystemPrompt: "WORK_MODEL\n\nrole overlay\n\ngoal context",
  tools: ["read", "grep", "workstream_submit"],
  skills: ["/abs/skill-a"],
};

let dir: string;
beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "launch-identity-"));
});
afterEach(() => {
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("workstreamLaunchIdentity sidecar", () => {
  it("round-trips a full record (argv bytes + instance/model/options) verbatim", () => {
    writeLaunchIdentity(dir, A, baseRecord);
    expect(readLaunchIdentity(dir, A)).toEqual(baseRecord);
    // The stored appendSystemPrompt is the final argv value, exactly once — no
    // double work-model prepend on replay.
    const stored = readLaunchIdentity(dir, A);
    expect(stored?.appendSystemPrompt?.match(/WORK_MODEL/g)?.length).toBe(1);
  });

  it("returns undefined for a thread with no record (source predates the feature)", () => {
    expect(readLaunchIdentity(dir, A)).toBeUndefined();
  });

  it("keeps per-thread records isolated", () => {
    writeLaunchIdentity(dir, A, baseRecord);
    writeLaunchIdentity(dir, B, { ...baseRecord, model: "gpt-5.4" });
    expect(readLaunchIdentity(dir, A)?.model).toBe("google-vertex-claude/claude-opus-4-8");
    expect(readLaunchIdentity(dir, B)?.model).toBe("gpt-5.4");
  });

  it("advances the applied model at settlement (an in-session reroute), preserving argv", () => {
    writeLaunchIdentity(dir, A, baseRecord);
    updateLaunchIdentityApplied(dir, A, {
      model: "google-vertex-claude/claude-opus-4-8-fallback",
    });
    const updated = readLaunchIdentity(dir, A);
    expect(updated?.model).toBe("google-vertex-claude/claude-opus-4-8-fallback");
    // Everything else (the cacheable prefix identity) is untouched.
    expect(updated?.appendSystemPrompt).toBe(baseRecord.appendSystemPrompt);
    expect(updated?.tools).toEqual(baseRecord.tools);
    expect(updated?.skills).toEqual(baseRecord.skills);
    expect(updated?.options).toEqual(baseRecord.options);
    expect(updated?.providerInstanceId).toBe(baseRecord.providerInstanceId);
  });

  it("keeps the FULL applied selection current: a mid-run thinking-level drop is captured (D2)", () => {
    writeLaunchIdentity(dir, A, baseRecord); // options: thinkingLevel=high
    updateLaunchIdentityApplied(dir, A, { model: baseRecord.model, thinkingLevel: "medium" });
    const updated = readLaunchIdentity(dir, A);
    // The stale high-thinking option is replaced, not left behind — else a fork
    // would replay onto stale high thinking.
    expect(updated?.options).toEqual([{ id: "thinkingLevel", value: "medium" }]);
  });

  it("upserts thinkingLevel alongside unrelated options", () => {
    writeLaunchIdentity(dir, A, {
      ...baseRecord,
      options: [
        { id: "other", value: "x" },
        { id: "thinkingLevel", value: "high" },
      ],
    });
    updateLaunchIdentityApplied(dir, A, { thinkingLevel: "low" });
    const updated = readLaunchIdentity(dir, A);
    expect(updated?.options).toContainEqual({ id: "other", value: "x" });
    expect(updated?.options).toContainEqual({ id: "thinkingLevel", value: "low" });
    expect(updated?.options?.filter((o) => o.id === "thinkingLevel")).toHaveLength(1);
  });

  it("applied update is a no-op when no record exists (nothing to advance)", () => {
    updateLaunchIdentityApplied(dir, A, { model: "gpt-5.4" });
    expect(readLaunchIdentity(dir, A)).toBeUndefined();
  });

  it("applied update with neither model nor thinking level leaves the record unchanged", () => {
    writeLaunchIdentity(dir, A, baseRecord);
    updateLaunchIdentityApplied(dir, A, {});
    expect(readLaunchIdentity(dir, A)).toEqual(baseRecord);
  });

  it("overwrites a prior record on relaunch (re-capture the stable argv/selection)", () => {
    writeLaunchIdentity(dir, A, baseRecord);
    writeLaunchIdentity(dir, A, { ...baseRecord, appendSystemPrompt: "recomposed" });
    expect(readLaunchIdentity(dir, A)?.appendSystemPrompt).toBe("recomposed");
  });

  it("deleteLaunchIdentity invalidates a stale record so a fork reads MISSING (loud refusal)", () => {
    writeLaunchIdentity(dir, A, baseRecord);
    deleteLaunchIdentity(dir, A);
    expect(readLaunchIdentity(dir, A)).toBeUndefined();
    // Idempotent / safe when already absent.
    deleteLaunchIdentity(dir, A);
    expect(readLaunchIdentity(dir, A)).toBeUndefined();
  });

  it("uses distinct file names for the sidecar and the marker", () => {
    expect(launchIdentityPath(dir, A).endsWith(".json")).toBe(true);
    expect(kickoffDeliveredMarkerPath(dir, A).endsWith(".kickoff-delivered")).toBe(true);
    expect(launchIdentityPath(dir, A)).not.toBe(kickoffDeliveredMarkerPath(dir, A));
  });
});

// loom: forkFrom (D2) — the actual createPiRpcProcess argv a fork's first launch
// produces, verified against the real argv builder: the source's FINAL bytes are
// replayed verbatim, exactly once (no second work-model prepend), with tools /
// skills / --fork intact.
describe("resolveForkLaunchArgs → buildPiRpcArgs (fork replay argv)", () => {
  const forkArgv = () => {
    const resolved = resolveForkLaunchArgs({
      forkRecord: baseRecord,
      // The composed value a non-fork launch WOULD use — note it re-prepends the
      // work-model prompt; the replay must ignore it entirely.
      composedAppendSystemPrompt: "WORK_MODEL\n\nWORK_MODEL\n\nrecomposed by reactor",
      startSkills: ["/composed/skill"],
      startTools: ["read", "edit", "bash"],
    });
    return buildPiRpcArgs({
      binaryPath: "pi",
      platform: "linux",
      sessionId: "child-session",
      forkFrom: "/abs/source.jsonl",
      ...(resolved.appendSystemPrompt ? { appendSystemPrompt: resolved.appendSystemPrompt } : {}),
      ...(resolved.skills && resolved.skills.length > 0 ? { skills: resolved.skills } : {}),
      ...(resolved.tools && resolved.tools.length > 0 ? { tools: resolved.tools } : {}),
    });
  };

  it("replays the source's final system prompt verbatim — no double work-model prepend", () => {
    const args = forkArgv();
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    const value = args[idx + 1]!;
    expect(value).toBe(baseRecord.appendSystemPrompt);
    // The record's final bytes carry exactly one work-model marker; the composed
    // (double-prepend) value is never used.
    expect(value.match(/WORK_MODEL/g)?.length).toBe(1);
    expect(value).not.toContain("recomposed by reactor");
  });

  it("replays the source's tools/skills and forks the source session", () => {
    const args = forkArgv();
    expect(args).toContain("--fork");
    expect(args[args.indexOf("--fork") + 1]).toBe("/abs/source.jsonl");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,workstream_submit");
    // The composed allowlist (read,edit,bash) is NOT used.
    expect(args[args.indexOf("--tools") + 1]).not.toContain("edit");
    const skillFlags = args.filter((a, i) => a === "--skill" && args[i + 1] === "/abs/skill-a");
    expect(skillFlags).toHaveLength(1);
    expect(args).not.toContain("/composed/skill");
  });

  it("a non-fork launch (no record) uses the composed argv unchanged", () => {
    const resolved = resolveForkLaunchArgs({
      forkRecord: undefined,
      composedAppendSystemPrompt: "WORK_MODEL\n\nrole overlay",
      startSkills: ["/composed/skill"],
      startTools: ["read", "edit"],
    });
    expect(resolved.appendSystemPrompt).toBe("WORK_MODEL\n\nrole overlay");
    expect(resolved.skills).toEqual(["/composed/skill"]);
    expect(resolved.tools).toEqual(["read", "edit"]);
  });
});

describe("workstreamLaunchIdentity kickoff-delivered marker (D8)", () => {
  it("is absent until the kickoff is delivered, present after, and survives 'restart'", () => {
    expect(isKickoffDelivered(dir, A)).toBe(false);
    markKickoffDelivered(dir, A);
    expect(isKickoffDelivered(dir, A)).toBe(true);
    // A fresh reader (a new server process) sees the same durable marker: the
    // marker is a file, not an in-memory/projection derivation.
    expect(NodeFS.existsSync(kickoffDeliveredMarkerPath(dir, A))).toBe(true);
    expect(isKickoffDelivered(dir, A)).toBe(true);
  });

  it("is independent of the launch-identity record (a record without a marker stays replay-eligible)", () => {
    writeLaunchIdentity(dir, A, baseRecord);
    expect(isKickoffDelivered(dir, A)).toBe(false);
  });

  it("is idempotent", () => {
    markKickoffDelivered(dir, A);
    markKickoffDelivered(dir, A);
    expect(isKickoffDelivered(dir, A)).toBe(true);
  });
});
