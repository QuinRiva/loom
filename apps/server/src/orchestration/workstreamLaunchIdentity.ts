// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalRandom:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";

/**
 * workstreamLaunchIdentity — durable, per-thread launch-identity sidecar and
 * kickoff-delivered marker for `forkFrom` child spawning (plan D2/D8).
 *
 * A `forkFrom` child forks a completed sibling's pi session so its transcript
 * prefix is byte-identical, which only pays off if the fork replays the SAME
 * cacheable prefix the source last ran on: the final argv system prompt, the
 * tool/skill allowlists, and the instance/model/options that actually consumed
 * that prefix. None of that is recoverable from the projection (role/goal/model
 * selection are all mutable intent, and pi recomposes the system prompt from
 * flags at every launch). So the pi DRIVER captures it at the exact
 * `createPiRpcProcess` boundary — the final argv bytes, AFTER the driver
 * prepends its work-model system prompt — keeps the model part current at every
 * turn settlement, and replays the whole record verbatim at a fork's first
 * launch.
 *
 * A companion **kickoff-delivered marker** (D8) records the moment a thread's
 * initial prompt was accepted by pi. Its ABSENCE — not the absence of a
 * completed turn — is what makes a thread's kickoff replay-eligible: a
 * pre-dispatch quota exhaustion, a provider-guard fork refusal, and a
 * restart-cleared pending start all leave the marker absent (the brief was
 * never written into the transcript), whereas a delivered-then-errored first
 * turn has the marker and must never be re-delivered.
 *
 * Storage mirrors {@link module:workstreamBrief} (per-thread files under the
 * durable state dir, never the ephemeral worktree) but is written from the pi
 * driver's synchronous `launch()`/turn-settlement paths, so the primitives here
 * are plain synchronous `node:fs` (the same posture as `piSessionFiles.ts`)
 * rather than Effect `FileSystem`. Writes are atomic (temp sibling + rename) so
 * a concurrent fork read never observes a torn record.
 *
 * @module workstreamLaunchIdentity
 */

/** One applied provider option (e.g. `{ id: "thinkingLevel", value: "high" }`). */
export interface LaunchIdentityOption {
  readonly id: string;
  readonly value: string | boolean;
}

/**
 * The bytes and selection a thread launched with — everything a fork needs to
 * reproduce the source's cacheable prefix. `appendSystemPrompt` is the FINAL
 * argv value (post work-model prepend), so replay must not re-prepend.
 */
export interface LaunchIdentityRecord {
  readonly providerInstanceId: string;
  /** The applied model slug; kept current at each turn settlement. */
  readonly model: string | undefined;
  readonly options: ReadonlyArray<LaunchIdentityOption> | undefined;
  readonly appendSystemPrompt: string | undefined;
  readonly tools: ReadonlyArray<string> | undefined;
  readonly skills: ReadonlyArray<string> | undefined;
}

/** Filesystem-safe base name for a thread's sidecar (threadIds are uuids). */
const safeName = (threadId: ThreadId): string => threadId.replace(/[^A-Za-z0-9._-]/g, "_");

/** Absolute path to a thread's launch-identity sidecar. */
export const launchIdentityPath = (dir: string, threadId: ThreadId): string =>
  NodePath.join(dir, `${safeName(threadId)}.json`);

/** Absolute path to a thread's kickoff-delivered marker. */
export const kickoffDeliveredMarkerPath = (dir: string, threadId: ThreadId): string =>
  NodePath.join(dir, `${safeName(threadId)}.kickoff-delivered`);

/** Atomic write of a string to `filePath` (temp sibling + rename). */
const atomicWrite = (dir: string, filePath: string, content: string): void => {
  NodeFS.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  NodeFS.writeFileSync(tempPath, content);
  try {
    NodeFS.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      NodeFS.rmSync(tempPath, { force: true });
    } catch {
      // best effort — never leave the temp file behind masking the real error
    }
    throw error;
  }
};

/**
 * Persist a thread's launch-identity record. Overwrites any previous record for
 * the thread (a relaunch re-captures the stable argv/selection; the model part
 * is then re-advanced by {@link updateLaunchIdentityModel} at turn settlement).
 */
export const writeLaunchIdentity = (
  dir: string,
  threadId: ThreadId,
  record: LaunchIdentityRecord,
): void => atomicWrite(dir, launchIdentityPath(dir, threadId), JSON.stringify(record));

/**
 * Delete a thread's launch-identity record. Used to INVALIDATE a stale record
 * when a fresh capture fails (D2): the record must reflect the current launch's
 * argv or be absent — an absent record yields a loud fork-launch refusal, never
 * a silent replay of stale argv/model. Best-effort; a delete failure is
 * swallowed (an already-absent file is success).
 */
export const deleteLaunchIdentity = (dir: string, threadId: ThreadId): void => {
  try {
    NodeFS.rmSync(launchIdentityPath(dir, threadId), { force: true });
  } catch {
    // best effort — an unremovable stale record is the irreducible best-effort
    // boundary (a failing disk); nothing more we can do synchronously here.
  }
};

/** Read a thread's launch-identity record, or undefined when none exists / is unreadable. */
export const readLaunchIdentity = (
  dir: string,
  threadId: ThreadId,
): LaunchIdentityRecord | undefined => {
  try {
    const raw = NodeFS.readFileSync(launchIdentityPath(dir, threadId), "utf8");
    const parsed = JSON.parse(raw) as LaunchIdentityRecord;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

/**
 * Advance the APPLIED selection of an existing record to what actually served a
 * turn's final round: the model slug AND the per-turn-mutable options (only
 * `thinkingLevel` changes per turn, via `applyModelSelection`). D2 requires the
 * FULL applied selection to be current — a source whose thinking dropped
 * high→medium mid-run must not fork children back onto stale high thinking.
 *
 * No-op when no record exists (nothing to advance). `model`/`thinkingLevel`
 * omitted individually leave that part untouched.
 */
export const updateLaunchIdentityApplied = (
  dir: string,
  threadId: ThreadId,
  applied: { readonly model?: string | undefined; readonly thinkingLevel?: string | undefined },
): void => {
  const existing = readLaunchIdentity(dir, threadId);
  if (existing === undefined) return;
  const model = applied.model ?? existing.model;
  let options = existing.options;
  if (applied.thinkingLevel !== undefined) {
    const rest = (existing.options ?? []).filter((option) => option.id !== "thinkingLevel");
    options = [...rest, { id: "thinkingLevel", value: applied.thinkingLevel }];
  }
  if (model === existing.model && JSON.stringify(options) === JSON.stringify(existing.options)) {
    return;
  }
  writeLaunchIdentity(dir, threadId, { ...existing, model, options });
};

/**
 * Pure resolution of the cache-critical argv a launch uses (D2). On a fork's
 * FIRST launch (`forkRecord` present) the source's captured FINAL argv bytes are
 * replayed verbatim — no reactor recomposition and, crucially, no second
 * `PI_WORK_MODEL_SYSTEM_PROMPT` prepend, because `appendSystemPrompt` is already
 * the final value. Otherwise the composed/allow-listed values are used. Exposed
 * so the no-double-prepend / verbatim-replay invariant is unit-testable against
 * {@link buildPiRpcArgs} without spawning pi.
 */
export const resolveForkLaunchArgs = (input: {
  readonly forkRecord: LaunchIdentityRecord | undefined;
  readonly composedAppendSystemPrompt: string | undefined;
  readonly startSkills: ReadonlyArray<string> | undefined;
  readonly startTools: ReadonlyArray<string> | undefined;
}): {
  readonly appendSystemPrompt: string | undefined;
  readonly skills: ReadonlyArray<string> | undefined;
  readonly tools: ReadonlyArray<string> | undefined;
} =>
  input.forkRecord
    ? {
        appendSystemPrompt: input.forkRecord.appendSystemPrompt,
        skills: input.forkRecord.skills,
        tools: input.forkRecord.tools,
      }
    : {
        appendSystemPrompt: input.composedAppendSystemPrompt,
        skills: input.startSkills,
        tools: input.startTools,
      };

/** Persist the positive kickoff-delivered marker (idempotent). */
export const markKickoffDelivered = (dir: string, threadId: ThreadId): void =>
  atomicWrite(dir, kickoffDeliveredMarkerPath(dir, threadId), new Date().toISOString());

/**
 * Whether a thread's kickoff has been delivered to pi. Absence means the
 * composed kickoff was never written into the transcript and must be
 * (re)delivered on the next turn-start (D8).
 */
export const isKickoffDelivered = (dir: string, threadId: ThreadId): boolean => {
  try {
    return NodeFS.existsSync(kickoffDeliveredMarkerPath(dir, threadId));
  } catch {
    return false;
  }
};
