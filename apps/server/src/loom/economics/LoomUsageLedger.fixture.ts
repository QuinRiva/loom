/**
 * FIXTURE LAYER (3d-4, DL-438) — deterministic spend for 3d's Cost tab, board
 * cost and context chips until track 3c's real `LoomUsageLedger.layer` (SQL over
 * `loom_usage_ledger`, migration 1049) replaces it at integration: delete this
 * file and its line in `loom/serverLayers.ts`, and provide 3c's
 * `LoomDriverEconomicsLive` there instead.
 *
 * Every thread id hashes to a stable spend, so the dev seed's threads (and any
 * other) show figures; `topSpend` ranks the seed's threads. `since` is ignored.
 *
 * @module loom/economics/LoomUsageLedger.fixture
 */
import type { ThreadId } from "@t3tools/contracts";
import { LOOM_SEED } from "@t3tools/shared/loomSeedFixture.loom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { LoomUsageLedger, type ThreadSpend } from "./LoomUsageLedger.ts";

/** FNV-1a over the id: the same thread always reports the same spend. */
const hashOf = (value: string) =>
  [...value].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>>
  0;

export const fixtureSpendOf = (threadId: ThreadId): ThreadSpend => {
  const hash = hashOf(threadId);
  const inputTokens = 20_000 + (hash % 180_000);
  const outputTokens = 2_000 + ((hash >>> 8) % 30_000);
  const cachedTokens = 50_000 + ((hash >>> 4) % 900_000);
  return {
    costUsd: Math.round((inputTokens * 3 + outputTokens * 15 + cachedTokens * 0.3) / 10_000) / 100,
    inputTokens,
    outputTokens,
    cachedTokens,
  };
};

export const LoomUsageLedgerFixtureLive = Layer.succeed(LoomUsageLedger, {
  threadSpend: (threadIds) =>
    Effect.succeed(new Map(threadIds.map((threadId) => [threadId, fixtureSpendOf(threadId)]))),
  topSpend: (limit) =>
    Effect.succeed(
      Object.values(LOOM_SEED.threads)
        .map((threadId) => ({ threadId, ...fixtureSpendOf(threadId) }))
        .toSorted((left, right) => right.costUsd - left.costUsd)
        .slice(0, limit),
    ),
});
