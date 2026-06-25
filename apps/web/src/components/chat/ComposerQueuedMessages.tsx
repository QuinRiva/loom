import { ArrowUpIcon, ClockIcon } from "lucide-react";

import { cn } from "~/lib/utils";

interface ComposerQueuedMessagesProps {
  readonly className?: string;
  readonly steering: ReadonlyArray<string>;
  readonly followUp: ReadonlyArray<string>;
}

/**
 * Ephemeral pending-message rows shown just above the composer while a turn is
 * running. `steering` messages fold into the live turn; `followUp` run after.
 * The list is driven straight off live session state, so rows clear on their
 * own as the provider drains each queue.
 */
export function ComposerQueuedMessages({
  className,
  steering,
  followUp,
}: ComposerQueuedMessagesProps) {
  if (steering.length === 0 && followUp.length === 0) return null;
  return (
    <div className={cn("mb-1.5 flex flex-col gap-1", className)}>
      {steering.map((message, index) => (
        <QueuedRow
          key={`steer-${index}`}
          icon={<ArrowUpIcon className="size-3" />}
          label="Steering"
        >
          {message}
        </QueuedRow>
      ))}
      {followUp.map((message, index) => (
        <QueuedRow key={`follow-${index}`} icon={<ClockIcon className="size-3" />} label="Queued">
          {message}
        </QueuedRow>
      ))}
    </div>
  );
}

function QueuedRow({
  icon,
  label,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly children: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
      <span className="flex shrink-0 items-center gap-1 font-medium text-foreground/70">
        {icon}
        {label}
      </span>
      <span className="truncate">{children}</span>
    </div>
  );
}
