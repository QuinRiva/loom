import { cn } from "../lib/utils";

/** A thread-state dot in a `COLUMN_STYLES` (or attention) colour: filled, or a ring when `hollow`. */
export function StatusDot({
  color,
  hollow = false,
  className,
}: {
  readonly color: string;
  readonly hollow?: boolean | undefined;
  readonly className?: string;
}) {
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", className)}
      style={hollow ? { border: `1.5px solid ${color}` } : { backgroundColor: color }}
    />
  );
}
