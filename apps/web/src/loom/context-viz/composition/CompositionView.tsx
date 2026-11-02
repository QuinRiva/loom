// loom: the Composition sub-view (plan §5); a stub until P4 fills it.
import type { ContextViewProps } from "../contextUsageStore";

export function CompositionView({ report }: ContextViewProps) {
  return (
    <p className="text-sm text-muted-foreground/70">
      Composition of {report.items.length} items is not built yet.
    </p>
  );
}
