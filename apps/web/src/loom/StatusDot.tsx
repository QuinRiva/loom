import type { StatusShape } from "../lib/workstreamPresentation";
import { cn } from "../lib/utils";

/** A thread-state dot in a `COLUMN_STYLES` (or attention) colour, in its state's shape. */
export function StatusDot({
  color,
  shape = "dot",
  className,
}: {
  readonly color: string;
  readonly shape?: StatusShape | undefined;
  readonly className?: string;
}) {
  return (
    <span
      className={cn("inline-grid size-2 shrink-0 place-items-center rounded-full", className)}
      style={
        shape === "dot" ? { backgroundColor: color } : { boxShadow: `inset 0 0 0 1.5px ${color}` }
      }
    >
      {shape === "target" ? (
        <span className="size-0.75 rounded-full" style={{ backgroundColor: color }} />
      ) : null}
    </span>
  );
}
