/**
 * Thread-search eval: the 57 queries in `threadSearchQueries.json` against a COPY of a real
 * database (migrated and written in place), ranked by Loom lexical / semantic / fused under
 * both scopes and by upstream's trigram `search` and `searchThreads`. Usage: `--help`.
 */
// Dev-only harness (not shipped): plain Node/JSON/Date keep it legible, matching `scripts/*.ts`.
// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off globalConsoleInEffect:off globalConsole:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadSearchEmbeddingSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { layerFromPath } from "../persistence/Sqlite.ts";
import {
  ThreadEmbedder,
  makeThreadEmbedder,
  providerFromSettings,
} from "../orchestration-v2/ThreadEmbedder.loom.ts";
import { makeThreadSearch } from "../orchestration-v2/ThreadSearch.loom.ts";
import { make as makeUpstreamThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import queries from "./threadSearchQueries.json" with { type: "json" };

// Floors on the set's own corpus under `scope: "all"` (origin/main's ranking), whole percent.
// Exact identifiers: all 8 in the top 3, and `exactR1` of them at #1. Re-baselined 23 Oct 2026.
const FLOORS: Record<string, { r5?: number; r10?: number; mrr?: number; exactR1: number }> = {
  local: { r5: 67, mrr: 0.5, exactR1: 7 },
  vertex: { r5: 79, mrr: 0.58, exactR1: 8 },
  none: { r10: 40, mrr: 0.27, exactR1: 7 },
  "openai-compatible": { exactR1: 8 },
};
const percent = (count: number, n: number) => Math.round((100 * count) / n);

const { values } = NodeUtil.parseArgs({
  options: {
    help: { type: "boolean" },
    db: { type: "string" },
    provider: { type: "string" },
    exclude: { type: "string", default: "59bbc9a4-f2a8-4147-b80b-6644778bc6d5" },
    "corpus-until": { type: "string", default: "2026-10-01" },
  },
});
if (values.help) {
  console.log(`node apps/server/src/dev/threadSearchEval.loom.ts --db <copy>/statev2.sqlite
  [--provider none|local|openai-compatible|vertex]  settings.json beside the db when it matches
  [--corpus-until 2026-10-01|none]  drop roots created later except a query's own target; none: no floor
  [--exclude <rootId,...>]  drop roots except as targets (default: the root that authored the set)`);
  process.exit(0);
}
const corpusUntil = values["corpus-until"] === "none" ? undefined : values["corpus-until"];
const excluded = new Set(values.exclude.split(",").filter(Boolean));
const keep = (ids: ReadonlyArray<string> | undefined, expected: ReadonlyArray<string>) =>
  ids?.filter((id) => !excluded.has(id) || expected.includes(id));
const dbPath = NodePath.resolve(values.db ?? ".t3/eval/statev2.sqlite");
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
      `sweep embedded ${sweep.embedded} roots in ${Date.now() - sweepStarted} ms; ` +
      `RSS ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB`,
  );
  const search = yield* makeThreadSearch.pipe(Effect.provideService(ThreadEmbedder, embedder));

  const roots = yield* sql<{ readonly id: string; readonly createdAt: string }>`
    SELECT thread_id AS id, created_at AS "createdAt" FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND json_extract(payload_json, '$.lineage.parentThreadId') IS NULL`;
  const live = new Set(roots.map((row) => row.id));
  // A bare date covers that whole day: ISO timestamps on it sort after the date alone.
  const newer = roots.filter(
    (row) => corpusUntil !== undefined && row.createdAt.slice(0, corpusUntil.length) > corpusUntil,
  );
  for (const row of newer) excluded.add(row.id);
  const corpus =
    corpusUntil === undefined
      ? `full corpus (${roots.length} roots), no floor`
      : `set's corpus: roots created through ${corpusUntil} (${roots.length - newer.length} of ${roots.length})`;
  console.log(corpus);
  const upstream = yield* makeUpstreamThreadSearch;
  yield* search.rank("warm up query"); // first query embed loads lazily
  const SIDES = [
    "roots lexical",
    "roots semantic",
    "roots fused",
    "all lexical",
    "all semantic",
    "all fused",
    "upstream search",
    "upstream searchThreads",
  ] as const;
  type Side = (typeof SIDES)[number];
  const results: Array<{
    readonly query: (typeof queries)[number];
    readonly ranks: Record<Side, number | null>;
    readonly ms: Partial<Record<Side, number>>;
    readonly top: ReadonlyArray<string>;
  }> = [];
  let skipped = 0;
  const timed = Effect.fn("threadSearchEval.timed")(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) {
    const started = performance.now();
    const value = yield* effect;
    return [value, performance.now() - started] as const;
  });
  for (const query of queries) {
    if (!query.expected.some((id) => live.has(id))) {
      skipped++;
      console.log(`skipped (target gone): ${query.q}`);
      continue;
    }
    const ranks = {} as Record<Side, number | null>;
    const ms: Partial<Record<Side, number>> = {};
    let top: ReadonlyArray<string> = [];
    for (const scope of ["roots", "all"] as const) {
      const ranked = yield* search.rank(query.q, { scope });
      const [, wall] = yield* timed(search.searchThreads({ query: query.q, limit: 30, scope }));
      ms[`${scope} fused`] = wall;
      const fused = keep(ranked.fused, query.expected)!;
      ranks[`${scope} lexical`] = rankOf(keep(ranked.lexical, query.expected), query.expected);
      ranks[`${scope} semantic`] = rankOf(keep(ranked.semantic, query.expected), query.expected);
      ranks[`${scope} fused`] = rankOf(fused, query.expected);
      if (scope === "roots") top = fused.slice(0, 5);
    }
    const [messages, messagesMs] = yield* timed(upstream.search({ query: query.q, limit: 50 }));
    const [threads, threadsMs] = yield* timed(
      upstream.searchThreads({ query: query.q, limit: 50 }),
    );
    ms["upstream search"] = messagesMs;
    ms["upstream searchThreads"] = threadsMs;
    const ids = (matches: ReadonlyArray<{ readonly threadId: string }>) =>
      keep(
        matches.map((match) => match.threadId),
        query.expected,
      );
    ranks["upstream search"] = rankOf(ids(messages.matches), query.expected);
    ranks["upstream searchThreads"] = rankOf(ids(threads.matches), query.expected);
    results.push({ query, ranks, ms, top });
  }

  const groups: Record<string, ReadonlyArray<string>> = {
    "headline 43": ["sampled", "plan"],
    "paraphrase 35": ["sampled"],
    "plan 8": ["plan"],
    "exact 8": ["exact"],
    "deep 6": ["deep"],
    "all 57": ["sampled", "plan", "exact", "deep"],
  };
  const archivedGroups: Record<string, (r: (typeof results)[number]) => boolean> = {
    "archived 18": (r) => r.query.archived,
    "active 39": (r) => !r.query.archived,
  };
  console.log(
    "\n| ranking | group | R@1 | R@3 | R@5 | R@10 | MRR |\n|---|---|---|---|---|---|---|",
  );
  for (const side of SIDES) {
    if (side.endsWith("semantic") && sweep.identity === undefined) continue;
    const rows = [
      ...Object.entries(groups).map(
        ([name, sources]) =>
          [name, (r: (typeof results)[number]) => sources.includes(r.query.source)] as const,
      ),
      ...Object.entries(archivedGroups),
    ];
    for (const [name, filter] of rows) {
      const m = metrics(results.filter(filter).map((r) => r.ranks[side]));
      console.log(
        `| ${side} | ${name} | ${pct(m.r1, m.n)} | ${pct(m.r3, m.n)} | ${pct(m.r5, m.n)} | ${pct(m.r10, m.n)} | ${m.mrr.toFixed(3)} |`,
      );
    }
  }

  for (const side of [
    "roots fused",
    "all fused",
    "upstream search",
    "upstream searchThreads",
  ] as const) {
    const times = results.map((r) => r.ms[side] ?? 0).toSorted((a, b) => a - b);
    console.log(
      `${side} wall time: p50 ${times[times.length >> 1]!.toFixed(1)} ms, ` +
        `p90 ${times[Math.floor(times.length * 0.9)]!.toFixed(1)} ms, max ${times.at(-1)!.toFixed(1)} ms`,
    );
  }
  console.log(`skipped ${skipped}`);
  // Per query, the top-5 hits each ranker has that another lacks.
  const within5 = (rank: number | null) => rank !== null && rank <= 5;
  const compared = [
    "roots lexical",
    "roots fused",
    "all fused",
    "upstream search",
    "upstream searchThreads",
  ] as const;
  console.log("\nper-query top-5 (1 = expected root in the top 5):");
  console.log(
    `| query | archived | ${compared.join(" | ")} |\n|---|---|${compared.map(() => "---").join("|")}|`,
  );
  for (const r of results)
    console.log(
      `| ${r.query.q} | ${r.query.archived ? "yes" : ""} | ${compared.map((side) => (within5(r.ranks[side]) ? `1 (#${r.ranks[side]})` : r.ranks[side] === null ? "0" : `0 (#${r.ranks[side]})`)).join(" | ")} |`,
    );
  const titles = new Map(
    (yield* sql<{ readonly id: string; readonly title: string }>`
      SELECT thread_id AS id, title FROM orchestration_v2_projection_threads`).map(
      (row) => [row.id, row.title] as const,
    ),
  );
  console.log("\nroots fused misses (rank > 5; exact identifiers rank > 1):");
  for (const r of results.filter(
    (r) => (r.ranks["roots fused"] ?? 99) > (r.query.source === "exact" ? 1 : 5),
  ))
    console.log(
      `- [${r.query.source}] "${r.query.q}" -> ${r.query.title} at ${r.ranks["roots fused"] ?? "none"} ` +
        `(all ${r.ranks["all fused"] ?? "none"}, upstream ${r.ranks["upstream search"] ?? "none"}); top-5: ` +
        r.top.map((id) => (titles.get(id) ?? id).replace(/\s+/g, " ").slice(0, 40)).join(" | "),
    );

  const headline = metrics(
    results
      .filter((r) => ["sampled", "plan"].includes(r.query.source))
      .map((r) => r.ranks["all fused"]),
  );
  const exact = metrics(
    results.filter((r) => r.query.source === "exact").map((r) => r.ranks["all fused"]),
  );
  if (corpusUntil === undefined) {
    console.log(`\nINFO: ${settings.provider}, ${corpus}`);
    return;
  }
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
  console.log(
    failures.length === 0
      ? `\nPASS: floor cleared (${settings.provider}, ${corpus})`
      : `\nFAIL: ${failures.join("; ")} (${settings.provider}, ${corpus})`,
  );
  if (failures.length > 0) process.exitCode = 1;
}).pipe(Effect.provide(layerFromPath(dbPath).pipe(Layer.provideMerge(NodeServices.layer))));

if (import.meta.main) {
  NodeRuntime.runMain(main);
}
