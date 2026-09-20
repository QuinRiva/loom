import { Loader2Icon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { isElectron } from "../env";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

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
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </WorkspacePageHeader>

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
