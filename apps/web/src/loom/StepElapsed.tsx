import { useLayoutEffect, useRef } from "react";

import { LONG_STEP_MS } from "../lib/workstreamPresentation";

const LONG_CLASS = "text-warning-foreground";

/** `23s` / `4m 05s` / `1h 02m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return hours === 0
    ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
    : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Time since `since`, ticking once a second by DOM write (zero React commits per tick, as
 * `AgentElapsed`); amber past `LONG_STEP_MS` unless `amber` is off, frozen with `until`. Mount it
 * only while visible (the hover card, a running consult card), so the interval lives only while shown.
 */
export function StepElapsed({
  since,
  until = null,
  amber = true,
}: {
  readonly since: string;
  readonly until?: string | null;
  readonly amber?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // Filled before paint, then by DOM write, so the clock is never read during render.
  useLayoutEffect(() => {
    const update = () => {
      const ms = (until === null ? Date.now() : Date.parse(until)) - Date.parse(since);
      ref.current!.textContent = formatElapsed(ms);
      ref.current!.classList.toggle(LONG_CLASS, amber && ms >= LONG_STEP_MS);
    };
    update();
    if (until !== null) return;
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [since, until, amber]);
  return <span ref={ref} className="tabular-nums" />;
}
