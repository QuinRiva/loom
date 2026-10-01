/**
 * Thread-search acceptance harness (plans/thread-content-search, Verification).
 *
 * Runs the 57-query set in `threadSearchQueries.json` against a COPY of a real
 * database through the production code path — migrations (FTS5 backfill), the
 * embedder sweep, then `ThreadSearch.rank` per query — and prints R@1/3/5/10 and
 * MRR per query group for lexical / semantic / fused, per-query wall time, and
 * the fused top-5 for each miss. Exits non-zero below the provider's floor.
 *
 * Run: `node apps/server/src/dev/threadSearchEval.loom.ts --db .t3/eval/state.sqlite [--provider none|local|openai-compatible|vertex]`
 *
 * `--exclude <rootId,…>` drops roots from every ranking except where they are the
 * query's own target. The default is the root whose subtree authored this set:
 * its transcripts and reports quote every query verbatim, so on any database
 * newer than the set it is a full-term lexical match for all of them.
 *
 * The provider block comes from `settings.json` beside the database when its
 * `provider` matches (or no `--provider` is given); otherwise the provider's
 * defaults. The database is migrated and written (embeddings) in place.
 *
 * @module dev/threadSearchEval
 */
// Dev-only harness (not shipped): plain Node/JSON/Date keep it legible, matching `scripts/*.ts`.
// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off globalConsoleInEffect:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadSearchEmbeddingSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  ThreadEmbedder,
  makeThreadEmbedder,
  providerFromSettings,
} from "../orchestration/Layers/ThreadEmbedder.loom.ts";
import { makeThreadSearch } from "../orchestration/Layers/ThreadSearch.loom.ts";
import queries from "./threadSearchQueries.json" with { type: "json" };

// The plan's floors, in whole percent as the plan reports them (30/43 is its "70 %").
// Exact identifiers: all 8 in the top 3, and `exactR1` of them at #1.
const FLOORS: Record<string, { r5?: number; r10?: number; mrr?: number; exactR1: number }> = {
  local: { r5: 70, mrr: 0.5, exactR1: 7 },
  vertex: { r5: 80, mrr: 0.58, exactR1: 8 },
  none: { r10: 40, mrr: 0.27, exactR1: 7 },
  "openai-compatible": { exactR1: 8 },
};
const percent = (count: number, n: number) => Math.round((100 * count) / n);

const { values } = NodeUtil.parseArgs({
  options: {
    db: { type: "string" },
    provider: { type: "string" },
    exclude: { type: "string", default: "59bbc9a4-f2a8-4147-b80b-6644778bc6d5" },
  },
});
const excluded = new Set(values.exclude.split(",").filter(Boolean));
const keep = (ids: ReadonlyArray<string> | undefined, expected: ReadonlyArray<string>) =>
  ids?.filter((id) => !excluded.has(id) || expected.includes(id));
const dbPath = NodePath.resolve(values.db ?? ".t3/eval/state.sqlite");
const stateDir = NodePath.dirname(dbPath);

const decodeSettings = Schema.decodeUnknownSync(ThreadSearchEmbeddingSettings);
const resolveSettings = () => {
  const settingsPath = NodePath.join(stateDir, "settings.json");
  const configured = NodeFS.existsSync(settingsPath)
    ? JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")).threadSearchEmbedding
    : undefined;
  const wanted = values.provider ?? configured?.provider ?? "local";
  return decodeSettings(configured?.provider === wanted ? configured : { provider: wanted });
};

type Ranks = Array<number | null>;
const metrics = (ranks: Ranks) => {
  const within = (k: number) => ranks.filter((rank) => rank !== null && rank <= k).length;
  return {
    n: ranks.length,
    r1: within(1),
    r3: within(3),
    r5: within(5),
    r10: within(10),
    mrr: ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / (ranks.length || 1),
  };
};
const rankOf = (list: ReadonlyArray<string> | undefined, expected: ReadonlyArray<string>) => {
  const index = list?.findIndex((id) => expected.includes(id)) ?? -1;
  return index < 0 ? null : index + 1;
};
const pct = (count: number, n: number) => `${count}/${n} (${percent(count, n)}%)`;

const main = Effect.gen(function* () {
  const settings = resolveSettings();
  const sql = yield* SqlClient.SqlClient;
  const embedder = yield* makeThreadEmbedder(
    Effect.succeed(providerFromSettings(settings, NodePath.join(stateDir, "models"))),
  );
  const sweepStarted = Date.now();
  const sweep = yield* embedder.sweep;
  console.log(
    `provider ${settings.provider} → identity ${sweep.identity ?? "(none: lexical-only)"}; ` +
      `sweep embedded ${sweep.embedded} roots in ${Date.now() - sweepStarted} ms`,
  );
  const search = yield* makeThreadSearch.pipe(Effect.provideService(ThreadEmbedder, embedder));

  const live = new Set(
    (yield* sql<{ readonly id: string }>`
      SELECT thread_id AS id FROM projection_threads
      WHERE parent_thread_id IS NULL AND deleted_at IS NULL`).map((row) => row.id),
  );
  yield* search.rank("warm up query"); // first query embed loads lazily
  const results: Array<{
    readonly query: (typeof queries)[number];
    readonly lexical: number | null;
    readonly semantic: number | null;
    readonly fused: number | null;
    readonly ms: number;
    readonly top: ReadonlyArray<string>;
  }> = [];
  let skipped = 0;
  for (const query of queries) {
    if (!query.expected.some((id) => live.has(id))) {
      skipped++;
      console.log(`skipped (target gone): ${query.q}`);
      continue;
    }
    const ranked = yield* search.rank(query.q);
    const started = performance.now();
    yield* search.searchThreads({ query: query.q, limit: 30 });
    const fused = keep(ranked.fused, query.expected)!;
    results.push({
      query,
      ms: performance.now() - started,
      lexical: rankOf(keep(ranked.lexical, query.expected), query.expected),
      semantic: rankOf(keep(ranked.semantic, query.expected), query.expected),
      fused: rankOf(fused, query.expected),
      top: fused.slice(0, 5),
    });
  }

  const groups: Record<string, ReadonlyArray<string>> = {
    "headline 43": ["sampled", "plan"],
    "paraphrase 35": ["sampled"],
    "plan 8": ["plan"],
    "exact 8": ["exact"],
    "deep 6": ["deep"],
    "all 57": ["sampled", "plan", "exact", "deep"],
  };
  const table = (side: "lexical" | "semantic" | "fused") =>
    Object.entries(groups).map(([name, sources]) => {
      const m = metrics(
        results.filter((r) => sources.includes(r.query.source)).map((r) => r[side]),
      );
      return { name, m };
    });
  console.log(
    "\n| ranking | group | R@1 | R@3 | R@5 | R@10 | MRR |\n|---|---|---|---|---|---|---|",
  );
  for (const side of ["lexical", "semantic", "fused"] as const) {
    if (side === "semantic" && sweep.identity === undefined) continue;
    for (const { name, m } of table(side))
      console.log(
        `| ${side} | ${name} | ${pct(m.r1, m.n)} | ${pct(m.r3, m.n)} | ${pct(m.r5, m.n)} | ${pct(m.r10, m.n)} | ${m.mrr.toFixed(3)} |`,
      );
  }

  const times = results.map((r) => r.ms).toSorted((a, b) => a - b);
  console.log(
    `\nsearchThreads wall time (lexical ∥ semantic, fusion, snippets): p50 ${times[times.length >> 1]!.toFixed(1)} ms, ` +
      `p90 ${times[Math.floor(times.length * 0.9)]!.toFixed(1)} ms, max ${times.at(-1)!.toFixed(1)} ms; skipped ${skipped}`,
  );
  const titles = new Map(
    (yield* sql<{ readonly id: string; readonly title: string }>`
      SELECT thread_id AS id, title FROM projection_threads WHERE parent_thread_id IS NULL`).map(
      (row) => [row.id, row.title] as const,
    ),
  );
  console.log("\nfused misses (rank > 5; exact identifiers rank > 1):");
  for (const r of results.filter((r) => (r.fused ?? 99) > (r.query.source === "exact" ? 1 : 5)))
    console.log(
      `- [${r.query.source}] "${r.query.q}" → ${r.query.title} at ${r.fused ?? "—"} ` +
        `(lexical ${r.lexical ?? "—"}, semantic ${r.semantic ?? "—"}); top-5: ` +
        r.top.map((id) => (titles.get(id) ?? id).replace(/\s+/g, " ").slice(0, 40)).join(" | "),
    );

  const headline = metrics(
    results.filter((r) => ["sampled", "plan"].includes(r.query.source)).map((r) => r.fused),
  );
  const exact = metrics(results.filter((r) => r.query.source === "exact").map((r) => r.fused));
  const floor = FLOORS[sweep.identity === undefined ? "none" : settings.provider]!;
  const failures = [
    floor.r5 !== undefined &&
      percent(headline.r5, headline.n) < floor.r5 &&
      `headline R@5 < ${floor.r5}%`,
    floor.r10 !== undefined &&
      percent(headline.r10, headline.n) < floor.r10 &&
      `headline R@10 < ${floor.r10}%`,
    floor.mrr !== undefined && headline.mrr < floor.mrr && `headline MRR < ${floor.mrr}`,
    exact.r1 < floor.exactR1 && `exact-identifier R@1 ${exact.r1}/${exact.n} < ${floor.exactR1}`,
    exact.r3 < exact.n && `exact-identifier R@3 ${exact.r3}/${exact.n}`,
  ].filter(Boolean);
  console.log(failures.length === 0 ? "\nPASS: floor cleared" : `\nFAIL: ${failures.join("; ")}`);
  if (failures.length > 0) process.exitCode = 1;
}).pipe(
  Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provideMerge(NodeServices.layer))),
);

if (import.meta.main) {
  NodeRuntime.runMain(main);
}
