/**
 * loom: preview fixtures for the prompt-cache fuel ring and the hover card's
 * "Prompt cache" block — every ring state on both arms (keep-alive ping
 * pending, landed, missed; undecided; stopped; past the horizon; cold), plus an
 * unpriced model, no call on record and a working thread. Times are relative to
 * when the fixture renders.
 */
import { cacheLiveness } from "@t3tools/client-runtime/state/loom/cacheLiveness";
import type { LoomCacheRetention, LoomCacheWarming } from "@t3tools/contracts";
import { CircleCheckIcon } from "lucide-react";

import { ThreadHoverCard } from "../components/ThreadHoverCard";
import { CacheFuelRingView, cacheView } from "../loom/CacheFuelRing";
import { CacheHoverBlockView } from "../loom/CacheHoverBlock";
import type { PreviewGroup } from "./fixtures";

interface Case {
  readonly title: string;
  readonly retention: LoomCacheRetention;
  /** Minutes since the last real request was dispatched; null = none on record. */
  readonly startedAgo: number | null;
  /** How long that request ran, in seconds. */
  readonly durationS: number;
  /** Minutes since the last keep-alive ping landed; null = none. */
  readonly pingedAgo: number | null;
  readonly warming: LoomCacheWarming | null;
  readonly model: string;
  readonly context: number;
  readonly working?: boolean;
}

const OPUS = "cliproxy/claude-opus-5-5";
const FABLE = "cliproxy/claude-fable-5-1";

const CASES: ReadonlyArray<Case> = [
  {
    title: "1-hour root, ping pending (+20m)",
    retention: "long",
    startedAgo: 20,
    durationS: 40,
    pingedAgo: null,
    warming: "scheduled",
    model: FABLE,
    context: 185_000,
  },
  {
    title: "1-hour root, after its ping (+70m)",
    retention: "long",
    startedAgo: 70,
    durationS: 40,
    pingedAgo: 16,
    warming: "scheduled",
    model: OPUS,
    context: 546_000,
  },
  {
    title: "1-hour root, ping missed (+58m)",
    retention: "long",
    startedAgo: 58,
    durationS: 40,
    pingedAgo: null,
    warming: "scheduled",
    model: OPUS,
    context: 310_000,
  },
  {
    title: "1-hour root, draining (+105m)",
    retention: "long",
    startedAgo: 105,
    durationS: 40,
    pingedAgo: 51,
    warming: "scheduled",
    model: FABLE,
    context: 402_000,
  },
  {
    title: "5-minute, kept warm (+12m)",
    retention: "short",
    startedAgo: 12,
    durationS: 20,
    pingedAgo: 2.6,
    warming: "scheduled",
    model: OPUS,
    context: 254_000,
  },
  {
    title: "5-minute, undecided (+2m)",
    retention: "short",
    startedAgo: 2,
    durationS: 20,
    pingedAgo: null,
    warming: null,
    model: OPUS,
    context: 154_000,
  },
  {
    title: "5-minute, stopped (+1m)",
    retention: "short",
    startedAgo: 1,
    durationS: 20,
    pingedAgo: null,
    warming: "stopped",
    model: FABLE,
    context: 120_000,
  },
  {
    title: "5-minute, past the horizon (+31m)",
    retention: "short",
    startedAgo: 31,
    durationS: 20,
    pingedAgo: 3.8,
    warming: "scheduled",
    model: OPUS,
    context: 254_000,
  },
  {
    title: "Cold 1-hour root",
    retention: "long",
    startedAgo: 130,
    durationS: 40,
    pingedAgo: 76,
    warming: "stopped",
    model: FABLE,
    context: 502_000,
  },
  {
    title: "Cold 5-minute",
    retention: "short",
    startedAgo: 40,
    durationS: 20,
    pingedAgo: null,
    warming: "stopped",
    model: "cliproxy/claude-sonnet-5-5",
    context: 90_000,
  },
  {
    title: "Unpriced model (Sonnet 5)",
    retention: "long",
    startedAgo: 12,
    durationS: 40,
    pingedAgo: null,
    warming: "scheduled",
    model: "cliproxy/claude-sonnet-5",
    context: 120_000,
  },
  {
    title: "No call on record",
    retention: "short",
    startedAgo: null,
    durationS: 0,
    pingedAgo: null,
    warming: null,
    model: OPUS,
    context: 0,
  },
  {
    title: "Working thread",
    retention: "long",
    startedAgo: 1,
    durationS: 40,
    pingedAgo: null,
    warming: "scheduled",
    model: OPUS,
    context: 210_000,
    working: true,
  },
];

const viewOf = (c: Case) => {
  const now = Date.now();
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const startedMs = c.startedAgo === null ? null : now - c.startedAgo * 60_000;
  return cacheView(
    cacheLiveness(now, {
      retention: c.retention,
      requestStartedAt: iso(startedMs),
      requestEndedAt: iso(startedMs === null ? null : startedMs + c.durationS * 1000),
      pingedAt: iso(c.pingedAgo === null ? null : now - c.pingedAgo * 60_000),
      warming: c.warming,
    }),
    c.model,
    c.context,
  );
};

function SidebarRows() {
  return (
    <ul className="w-[300px] rounded-lg border border-border bg-sidebar p-1">
      {CASES.filter((c) => !c.working).map((c) => (
        <li key={c.title} className="rounded-md px-2.5 py-2 hover:bg-sidebar-row-hover">
          <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
            <span className="size-4 shrink-0 rounded-sm bg-primary/60" />
            <span className="min-w-0 flex-1 truncate font-medium text-secondary-label">loom</span>
            <CacheFuelRingView view={viewOf(c)} />
            <span className="inline-flex items-center gap-1 font-medium text-success">
              <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
              Done
            </span>
          </div>
          <div className="mt-1 truncate text-sm font-medium text-foreground">{c.title}</div>
        </li>
      ))}
    </ul>
  );
}

function HoverCards() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,320px)] gap-4">
      {CASES.map((c) => (
        <div key={c.title} className="w-80 rounded-lg border border-border bg-popover px-2">
          <ThreadHoverCard title={c.title}>
            <div className="min-w-0 truncate text-foreground/75">loom</div>
            <CacheHoverBlockView view={viewOf(c)} working={c.working === true} />
          </ThreadHoverCard>
        </div>
      ))}
    </div>
  );
}

export const CACHE_LIVENESS_PREVIEW_GROUP: PreviewGroup = {
  id: "loom-cache-liveness",
  title: "Loom prompt-cache liveness",
  fixtures: [
    {
      id: "loom-cache-ring-rows",
      title: "Fuel ring on sidebar rows",
      description:
        "Counts down to when the cache really goes cold, keep-alive pings included: full while a ping is coming, orange only in the last 10 minutes once no ping is coming (a missed ping, after the last one, or a stopped plan), neutral while undecided; snowflake once cold; no ring when nothing is on record. Hover a ring for its tooltip.",
      render: () => <SidebarRows />,
    },
    {
      id: "loom-cache-hover-block",
      title: "Prompt cache hover block",
      description:
        'The hover card\'s block in every state: "Kept warm until" while a ping is coming, else "Expires"; unpriced and working threads too.',
      render: () => <HoverCards />,
    },
  ],
};
