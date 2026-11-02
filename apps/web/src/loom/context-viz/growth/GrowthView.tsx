// loom: the Growth sub-view (plan §6); a stub until P5 fills it.
import type { ContextViewProps } from "../contextUsageStore";

export function GrowthView({ report }: ContextViewProps) {
  return (
    <p className="text-sm text-muted-foreground/70">
      Growth over {report.calls.length} calls is not built yet.
    </p>
  );
}
