// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { LoomCacheRetention } from "@t3tools/contracts";

/**
 * Per-thread Anthropic prompt-cache retention (the 1h-cache A/B). pi reads
 * `PI_CACHE_RETENTION=long` from its env and then marks cache breakpoints
 * `ttl: "1h"`; anything else is the 5-minute default. Roots idle while their
 * children work, so they re-write 5-minute caches the 1h cache would keep;
 * children are short-lived bursts and pay more on 1h. So only a root
 * (`parentThreadId === null`) can be long: when the first byte of
 * sha256(threadId) is below 256 × `rootCacheLongShare`. Raising the share only
 * moves 5-minute bytes to 1-hour, so the arm never depends on the share's
 * history. See docs/operations/prompt-cache-retention.md.
 */
export const cacheRetentionForThread = (
  threadId: string,
  isRoot: boolean,
  longShare: number,
): LoomCacheRetention =>
  isRoot && NodeCrypto.createHash("sha256").update(threadId).digest()[0]! < 256 * longShare
    ? "long"
    : "short";

/**
 * pi's idle-warming horizon for a 1-hour root, set per launch outside the launch
 * identity (the arm is identity; the horizon is policy). pi's warmer pings at 90%
 * of the TTL (54 min) after the last real request started, then 54 min after each
 * ping completes, while that next ping falls within this horizon of the start: 90
 * min admits the first (≈ 54 min) and not the second (≈ 108 min), so exactly one
 * ping, and the cache lives to ≈ 114 min.
 */
export const LONG_ROOT_IDLE_WARMING_MAX_MS = 90 * 60_000;

/** A 1-hour root's process outlives its one ping; past ≈ 114 min its cache is dead anyway. */
export const LONG_ROOT_IDLE_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * Append the retention a pi launch actually got, and the share in force, to
 * `<stateDir>/cache-retention-launches.jsonl`, one line per launch, so the
 * readout can stratify roots by allocation period. Best-effort: losing a line
 * must never fail a launch.
 */
export const recordCacheRetentionLaunch = (
  stateDir: string,
  threadId: string,
  cacheRetention: LoomCacheRetention,
  longShare: number,
): void => {
  try {
    NodeFS.appendFileSync(
      NodePath.join(stateDir, "cache-retention-launches.jsonl"),
      `${JSON.stringify({ threadId, cacheRetention, longShare, launchedAt: new Date().toISOString() })}\n`,
    );
  } catch {
    // best effort — analytics only
  }
};
