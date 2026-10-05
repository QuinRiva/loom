// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ProviderSessionStartInput, ServerSettings } from "@t3tools/contracts";

/**
 * Per-thread Anthropic prompt-cache retention (the 1h-cache A/B). pi reads
 * `PI_CACHE_RETENTION=long` from its env and then marks cache breakpoints
 * `ttl: "1h"`; anything else is the 5-minute default. Roots idle while their
 * children work, so they re-write 5-minute caches the 1h cache would keep;
 * children are short-lived bursts and pay more on 1h. So only a root
 * (`parentThreadId === null`) can be long, chosen by the `rootCacheRetention`
 * setting: `ab` splits roots 50/50 by a stable hash of the thread id, `long` /
 * `short` force every root. See docs/operations/prompt-cache-retention.md.
 */
export type CacheRetention = NonNullable<ProviderSessionStartInput["cacheRetention"]>;

/** Stable 50/50 arm: first byte of sha256(threadId) below 128 is `long`. */
export const hashedCacheRetention = (threadId: string): CacheRetention =>
  NodeCrypto.createHash("sha256").update(threadId).digest()[0]! < 128 ? "long" : "short";

export const cacheRetentionForThread = (
  threadId: string,
  isRoot: boolean,
  mode: ServerSettings["rootCacheRetention"],
): CacheRetention => (!isRoot ? "short" : mode === "ab" ? hashedCacheRetention(threadId) : mode);

/**
 * Append the retention a pi launch actually got to `<stateDir>/cache-retention-launches.jsonl`,
 * one line per launch, so the A/B join survives the setting changing mid-week.
 * Best-effort: losing a line must never fail a launch.
 */
export const recordCacheRetentionLaunch = (
  stateDir: string,
  threadId: string,
  cacheRetention: CacheRetention,
): void => {
  try {
    NodeFS.appendFileSync(
      NodePath.join(stateDir, "cache-retention-launches.jsonl"),
      `${JSON.stringify({ threadId, cacheRetention, launchedAt: new Date().toISOString() })}\n`,
    );
  } catch {
    // best effort — analytics only
  }
};
