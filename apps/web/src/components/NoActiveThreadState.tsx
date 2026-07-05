import { Loader2Icon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

const HEADER_CLASS = cn(
  "border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
  isElectron ? "workspace-topbar drag-region" : "workspace-topbar",
  COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
);

/**
 * Shown while a thread that is known to exist (its shell is in the environment
 * snapshot) waits for its detail subscription to deliver the first snapshot.
 * Without this state a first-ever visit — e.g. clicking a freshly spawned
 * sub-thread in the workstream graph — rendered an empty screen until the
 * per-thread stream hydrated.
 */
export function ThreadHydratingState({
  title,
  error,
}: {
  readonly title: string;
  readonly error: string | null;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className={HEADER_CLASS}>
          {isElectron ? (
            <span className="truncate text-xs text-muted-foreground/50 wco:pr-[var(--workspace-native-controls-inset)]">
              {title}
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground md:text-muted-foreground/60">
                {title}
              </span>
            </div>
          )}
        </header>

        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 px-8 text-center">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Loading conversation…</p>
            {error !== null && (
              <p className="max-w-md text-xs text-muted-foreground/70">{error} Retrying…</p>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className={HEADER_CLASS}>
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[var(--workspace-native-controls-inset)]">
              No active thread
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-xl">Pick a thread to continue</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Select an existing thread or create a new one to get started.
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
