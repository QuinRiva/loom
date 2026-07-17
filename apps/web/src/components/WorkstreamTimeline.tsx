import type { EnvironmentId, OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  BugIcon,
  ExternalLinkIcon,
  FileTextIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildThreadLifecycleRows,
  formatRelativeAge,
  getRoleLabel,
  LIFECYCLE_TONE_STYLES,
} from "../lib/workstreamPresentation";
import { isAbsolutePreviewablePath } from "../markdown-links";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomCommand } from "../state/use-atom-command";
import type { SidebarThreadSummary } from "../types";

export type LifecycleLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly events: ReadonlyArray<OrchestrationEvent> }
  | { readonly status: "error" };

/**
 * Fetch-on-selection + per-thread cache for the lifecycle timeline. Lives in the
 * *panel* (not the drawer component) so the cache survives Board⇄Graph view
 * switches and drawer open/close — a revisited thread is served from memory
 * (result sets are tens of rows and historical). Returns null when nothing is
 * inspected. Only re-fetches when the inspected thread changes; nothing polls.
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
 * Per-thread lifecycle drawer — the ordered journey (lane transitions, outcomes,
 * attention, rework rounds, fan-in) the latest-state read model collapses away.
 * Slides in from the panel's right, OVERLAYING the graph rather than pushing it
 * below the fold (a diagnostic opt-in, step 4 of the hierarchy of needs). The
 * panel owns the fetch/cache (see `useThreadLifecycle`); this is purely
 * presentational. Esc or a click on the backdrop dismisses it.
 */
export function WorkstreamLifecycleDrawer({
  thread,
  state,
  open,
  onClose,
  onOpenThread,
  onOpenDispatch,
  onOpenReport,
}: {
  readonly thread: SidebarThreadSummary | undefined;
  readonly state: LifecycleLoadState | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
  readonly onOpenDispatch: (threadId: ThreadId, anchorAtIso: string) => void;
  readonly onOpenReport: (reportPath: string) => void;
}) {
  const rows = useMemo(
    () => (state?.status === "ready" ? buildThreadLifecycleRows(state.events) : []),
    [state],
  );
  const asideRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // The element focused before the drawer opened (the node's ⓘ button), so
  // focus is restored to it on close.
  const restoreFocusRef = useRef<Element | null>(null);

  // Modal focus lifecycle: on open, remember the trigger, move focus into the
  // drawer, and contain Tab within it; on close, restore focus to the trigger.
  // Esc dismisses. The closed drawer is `inert` (below) so it is never tabbable.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement;
    // preventScroll: at this moment the drawer is still translated off-screen
    // (the slide-in has just started); a plain focus() makes the browser scroll
    // the overflow-hidden panel container sideways to reveal it, visibly
    // shunting the graph left before it bounces back.
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = asideRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus to the trigger when the drawer closes.
      if (restoreFocusRef.current instanceof HTMLElement)
        restoreFocusRef.current.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop: dims the graph and captures the click-outside dismiss. */}
      <div
        aria-hidden
        className={`absolute inset-0 z-20 bg-black/45 transition-opacity duration-200 motion-reduce:transition-none ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
      />
      <aside
        ref={asideRef}
        // `inert` when closed removes the whole panel from the tab order + a11y
        // tree (a translated-offscreen element is otherwise still tabbable).
        inert={!open}
        aria-hidden={!open}
        aria-modal={open}
        role="dialog"
        aria-label="Lifecycle history"
        className={`absolute inset-y-0 right-0 z-30 flex w-[340px] max-w-[85%] flex-col border-l border-white/20 bg-gradient-to-b from-[#10151d] to-[#0b0f15] shadow-[-20px_0_50px_rgba(0,0,0,0.5)] transition-transform duration-[260ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-white">{thread?.title ?? "—"}</div>
            <div className="truncate text-[10.5px] text-white/40">
              {thread ? getRoleLabel(thread) : "sub-thread"} · lifecycle
            </div>
          </div>
          {thread ? (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {thread.reportPath ? (
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/70 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-sky-400/70"
                  onClick={() => onOpenReport(thread.reportPath!)}
                  title="Open this thread's completion report"
                >
                  <FileTextIcon className="size-3" />
                  Report
                </button>
              ) : null}
              {/* Debugging-only: open the effective-prompt debug sidecar (the
                  full LLM prompt this pi thread sent, by section). Present only
                  for pi threads; reuses the generic open-absolute-path handler. */}
              {thread.promptDebugPath && isAbsolutePreviewablePath(thread.promptDebugPath) ? (
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/50 outline-none transition hover:bg-white/10 hover:text-white/80 focus-visible:ring-2 focus-visible:ring-sky-400/70"
                  onClick={() => onOpenReport(thread.promptDebugPath!)}
                  title="Open this thread's effective-prompt debug capture"
                >
                  <BugIcon className="size-3" />
                  Prompt
                </button>
              ) : null}
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/70 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-sky-400/70"
                onClick={() => onOpenThread(thread)}
                title="Open this thread's conversation"
              >
                <ExternalLinkIcon className="size-3" />
                Open thread
              </button>
            </div>
          ) : null}
          <button
            ref={closeRef}
            type="button"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-white/55 outline-none transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-sky-400/70"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close lifecycle history"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {!thread ? null : state?.status === "loading" ? (
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
                  <li key={row.key} className="flex items-stretch border-l border-white/10 pl-3">
                    {row.deepLink ? (
                      <button
                        type="button"
                        className="group -ml-px flex flex-1 items-start gap-2 rounded py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
                        onClick={() => onOpenDispatch(thread.id, row.at)}
                        title="Jump to this point in the thread's conversation"
                      >
                        {content}
                      </button>
                    ) : (
                      <div className="flex flex-1 items-start gap-2 py-1.5">{content}</div>
                    )}
                    {row.reportPath ? (
                      <button
                        type="button"
                        className="mt-0.5 ml-1 inline-flex size-6 shrink-0 items-center justify-center self-start rounded-md border border-white/10 bg-white/[0.03] text-white/45 outline-none transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-sky-400/70"
                        onClick={() => onOpenReport(row.reportPath!)}
                        title="Open this round's completion report"
                        aria-label="Open this round's completion report"
                      >
                        <FileTextIcon className="size-3" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </aside>
    </>
  );
}
