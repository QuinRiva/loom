import { useEffect, useReducer, useRef } from "react";

export const CONNECTION_OUTAGE_GRACE_MS = 12_000;

/**
 * Debounces transient connection outages so brief reconnect blips that
 * self-heal never alarm the user. Pass a stable key (e.g. the environment id)
 * while a transient outage (connecting/reconnecting) is ongoing, or null when
 * the connection is healthy or the failure is non-transient. Returns true only
 * once the same outage has persisted for the grace window.
 */
export function useSustainedConnectionOutage(
  outageKey: string | null,
  graceMs = CONNECTION_OUTAGE_GRACE_MS,
): boolean {
  const outageRef = useRef<{ key: string; since: number } | null>(null);
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);

  if (outageKey === null) {
    outageRef.current = null;
  } else if (outageRef.current?.key !== outageKey) {
    outageRef.current = { key: outageKey, since: Date.now() };
  }

  const sustained = outageRef.current !== null && Date.now() - outageRef.current.since >= graceMs;

  useEffect(() => {
    if (outageKey === null || sustained) {
      return;
    }
    const since = outageRef.current?.since ?? Date.now();
    const timer = setTimeout(rerender, Math.max(0, since + graceMs - Date.now()));
    return () => clearTimeout(timer);
  }, [outageKey, sustained, graceMs]);

  return sustained;
}
