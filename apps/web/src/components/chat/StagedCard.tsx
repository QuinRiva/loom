import { memo, type ReactNode } from "react";

import { Badge } from "../ui/badge";

interface StagedCardProps {
  /** Short uppercase badge label, with an optional leading icon. */
  readonly badgeLabel: string;
  readonly badgeIcon?: ReactNode;
  readonly title: string;
  /** Optional right-aligned header slot (e.g. a status hint). */
  readonly trailing?: ReactNode;
  /** Space to reserve at the bottom so the card clears the composer overlay. */
  readonly bottomInset?: number | undefined;
  /** Optional footer actions; the divider only appears when this is present. */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

/**
 * The empty-conversation card shell shared by the staged-kickoff offer and the
 * kickoff-brief preview: a scroll-safe overlay holding a bordered card with a
 * badge+title header, a scrollable markdown body, and an optional action footer.
 * Purely presentational — callers resolve their own body content (an inline
 * brief string, or a brief read from disk) and supply footer actions if any.
 */
export const StagedCard = memo(function StagedCard({
  badgeLabel,
  badgeIcon,
  title,
  trailing,
  bottomInset,
  footer,
  children,
}: StagedCardProps) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center overflow-y-auto px-4 py-6 sm:py-10"
      style={bottomInset ? { paddingBottom: bottomInset + 24 } : undefined}
    >
      <div className="pointer-events-auto flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
        <header className="flex items-center gap-2 border-border/60 border-b px-4 py-3 sm:px-5">
          <Badge
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold uppercase tracking-wide"
          >
            {badgeIcon}
            {badgeLabel}
          </Badge>
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{title}</span>
          {trailing}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5 sm:py-4">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-border/60 border-t px-4 py-3 sm:px-5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
});
