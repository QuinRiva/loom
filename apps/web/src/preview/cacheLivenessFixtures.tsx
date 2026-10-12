/**
 * loom: preview fixtures for the prompt-cache fuel ring and the hover card's
 * "Prompt cache" block — every ring state on both arms, plus an unpriced model
 * and a working thread. Times are relative to when the fixture renders.
 */
import { cacheLiveness } from "@t3tools/client-runtime/state/loom/cacheLiveness";
import type { LoomCacheRetention } from "@t3tools/contracts";
import { CircleCheckIcon } from "lucide-react";

import { ThreadHoverCard } from "../components/ThreadHoverCard";
import { CacheFuelRingView, cacheView } from "../loom/CacheFuelRing";
import { CacheHoverBlockView } from "../loom/CacheHoverBlock";
import type { PreviewGroup } from "./fixtures";

interface Case {
  readonly title: string;
  readonly retention: LoomCacheRetention;
  /** Minutes since the last call or ping; null = none on record. */
  readonly ago: number | null;
  readonly model: string;
  readonly context: number;
  readonly working?: boolean;
}

const CASES: ReadonlyArray<Case> = [
  {
    title: "Warm 1-hour root",
    retention: "long",
    ago: 22,
    model: "cliproxy/claude-fable-5-1",
    context: 185_000,
  },
  {
    title: "Expiring 1-hour root",
    retention: "long",
    ago: 52,
    model: "cliproxy/claude-opus-5-5",
    context: 546_000,
  },
  {
    title: "Cold 1-hour root",
    retention: "long",
    ago: 85,
    model: "cliproxy/claude-fable-5-1",
    context: 502_000,
  },
  {
    title: "Warm 5-minute root",
    retention: "short",
    ago: 2,
    model: "cliproxy/claude-opus-5-5",
    context: 154_000,
  },
  {
    title: "Cold 5-minute root",
    retention: "short",
    ago: 40,
    model: "cliproxy/claude-sonnet-5-5",
    context: 90_000,
  },
  {
    title: "Unpriced model (Sonnet 5)",
    retention: "long",
    ago: 12,
    model: "cliproxy/claude-sonnet-5",
    context: 120_000,
  },
  {
    title: "No call on record",
    retention: "short",
    ago: null,
    model: "cliproxy/claude-opus-5-5",
    context: 0,
  },
  {
    title: "Working thread",
    retention: "long",
    ago: 1,
    model: "cliproxy/claude-opus-5-5",
    context: 210_000,
    working: true,
  },
];

const viewOf = ({ retention, ago, model, context }: Case) => {
  const now = Date.now();
  return cacheView(
    cacheLiveness(now, ago === null ? null : now - ago * 60_000, retention),
    model,
    context,
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
        "Warm (neutral), expiring (orange, the whole of a 5-minute cache), cold (snowflake); no ring when nothing is on record. Hover a ring for its tooltip.",
      render: () => <SidebarRows />,
    },
    {
      id: "loom-cache-hover-block",
      title: "Prompt cache hover block",
      description: "The hover card's block in every state, including unpriced and working threads.",
      render: () => <HoverCards />,
    },
  ],
};
