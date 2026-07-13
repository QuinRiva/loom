import type { EnvironmentId, OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { ArrowUpRightIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildThreadLifecycleRows,
  formatRelativeAge,
  getRoleLabel,
  LIFECYCLE_TONE_STYLES,
} from "../lib/workstreamPresentation";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomCommand } from "../state/use-atom-command";
import type { SidebarThreadSummary } from "../types";

export type LifecycleLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly events: ReadonlyArray<OrchestrationEvent> }
  | { readonly status: "error" };

/**
 * Fetch-on-selection + per-thread cache for the lifecycle timeline. Lives in the
 * *panel* (not the timeline component) so the cache survives Board⇄Graph view
 * switches — the timeline unmounts on Board, but the panel does not — and a
 * revisited selection is served from memory (result sets are tens of rows and
 * historical). Returns null when nothing is selected. Only re-fetches when the
 * selected thread changes; nothing polls.
 */
export function useThreadLifecycle(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): LifecycleLoadState | null {
  const loadLifecycle = useAtomCommand(orchestrationEnvironment.loadThreadLifecycle, {
    reportFailure: false,
  });
  const cacheRef = useRef(new Map<ThreadId, ReadonlyArray<OrchestrationEvent>>());
  const [state, setState] = useState<LifecycleLoadState | null>(null);

  useEffect(() => {
    if (threadId === null || environmentId === null) {
      setState(null);
      return;
    }
    const cached = cacheRef.current.get(threadId);
    if (cached) {
      setState({ status: "ready", events: cached });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void loadLifecycle({ environmentId, input: { threadId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        cacheRef.current.set(threadId, result.value);
        setState({ status: "ready", events: result.value });
      } else {
        setState({ status: "error" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [threadId, environmentId, loadLifecycle]);

  return state;
}

/**
 * Per-thread lifecycle timeline — the ordered journey (lane transitions,
 * outcomes, attention, rework rounds, fan-in) the latest-state read model
 * collapses away. Rendered as a panel section below the graph canvas (a sibling
 * of the lazy graph chunk, never inside the SVG). Purely presentational: the
 * panel owns the fetch/cache (see `useThreadLifecycle`) so it persists across
 * view switches. Quiet loading/error states never break the graph above.
 */
export function WorkstreamTimeline({
  selectedThread,
  state,
  onOpenThread,
  onOpenDispatch,
}: {
  readonly selectedThread: SidebarThreadSummary | undefined;
  readonly state: LifecycleLoadState | null;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
  readonly onOpenDispatch: (threadId: ThreadId, anchorAtIso: string) => void;
}) {
  const rows = useMemo(
    () => (state?.status === "ready" ? buildThreadLifecycleRows(state.events) : []),
    [state],
  );

  if (!selectedThread) {
    return (
      <div className="mt-3 rounded-xl border border-white/10 bg-black/20 px-3 py-4 text-center text-[11px] text-white/35">
        Select a node above to inspect its lifecycle history.
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-black/20">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-white">{selectedThread.title}</div>
          <div className="truncate text-[10.5px] text-white/40">
            {getRoleLabel(selectedThread)} · lifecycle
          </div>
        </div>
        <button
          type="button"
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/10"
          onClick={() => onOpenThread(selectedThread)}
          title="Open this thread's conversation"
        >
          <ExternalLinkIcon className="size-3" />
          Open thread
        </button>
      </div>

      <div className="px-3 py-2">
        {state?.status === "loading" ? (
          <div className="flex items-center gap-2 py-3 text-[11px] text-white/40">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading history…
          </div>
        ) : state?.status === "error" ? (
          <div className="py-3 text-[11px] text-white/40">Couldn&rsquo;t load history.</div>
        ) : rows.length === 0 ? (
          <div className="py-3 text-[11px] text-white/35">No lifecycle events recorded yet.</div>
        ) : (
          <ol className="flex flex-col">
            {rows.map((row) => {
              const tone = LIFECYCLE_TONE_STYLES[row.tone];
              const content = (
                <>
                  <span className={`mt-1 size-2 shrink-0 rounded-full ${tone.dotClass}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`text-xs font-medium ${tone.textClass}`}>{row.label}</span>
                    {row.detail ? (
                      <span className="ml-1.5 text-[11px] text-white/45">{row.detail}</span>
                    ) : null}
                  </span>
                  {row.deepLink ? (
                    <ArrowUpRightIcon className="mt-0.5 size-3 shrink-0 text-white/30 group-hover:text-white/60" />
                  ) : null}
                  <span
                    className="mt-0.5 shrink-0 font-mono text-[10px] tabular-nums text-white/35"
                    title={row.at}
                  >
                    {formatRelativeAge(row.at)}
                  </span>
                </>
              );
              return (
                <li key={row.key} className="border-l border-white/10 pl-3">
                  {row.deepLink ? (
                    <button
                      type="button"
                      className="group -ml-px flex w-full items-start gap-2 py-1.5 text-left outline-none"
                      onClick={() => onOpenDispatch(selectedThread.id, row.at)}
                      title="Jump to this point in the thread's conversation"
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="flex w-full items-start gap-2 py-1.5">{content}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
