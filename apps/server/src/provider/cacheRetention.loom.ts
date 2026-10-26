// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { LoomCacheRetention } from "@t3tools/contracts";

/**
 * Per-thread Anthropic prompt-cache retention: pi marks breakpoints `ttl: "1h"` when its env has
 * `PI_CACHE_RETENTION=long`. Only roots qualify (they idle while children work; short-lived
 * children pay more on 1h): long when sha256(threadId)'s first byte is below 256 ×
 * `rootCacheLongShare`, so raising the share only ever moves threads to 1h.
 */
export const cacheRetentionForThread = (
  threadId: string,
  isRoot: boolean,
  longShare: number,
): LoomCacheRetention =>
  isRoot && NodeCrypto.createHash("sha256").update(threadId).digest()[0]! < 256 * longShare
    ? "long"
    : "short";

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
