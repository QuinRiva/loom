import { createFileRoute, Link } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";

import { NoActiveThreadState } from "../components/NoActiveThreadState";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { useSavedEnvironmentRegistryStore } from "../environments/runtime";
import { TaskTree, useGoalIndex } from "../goals/goalIndex";
import { APP_DISPLAY_NAME } from "~/branding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const savedEnvironmentCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );
  const goalsQuery = useGoalIndex();
  const goals = goalsQuery.data ?? [];

  if (authGateState.status === "hosted-static" && savedEnvironmentCount === 0) {
    return <HostedStaticOnboardingState />;
  }

  if (goals.length === 0) return <NoActiveThreadState />;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/70">
              Goal overview
            </span>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
          <div className="mx-auto grid w-full max-w-5xl gap-4">
            {goals.map((goal) => (
              <section key={goal.slug} className="rounded-2xl border border-border/70 bg-card/55 p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold text-foreground">
                      {goal.title || goal.slug}
                    </h2>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                      {goal.goalParagraph || "No ## Goal paragraph yet."}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-border/70 px-2 py-1 text-xs tabular-nums text-muted-foreground">
                    {goal.progress.done}/{goal.progress.total}
                  </span>
                </div>
                <div className="mt-4 rounded-xl border border-border/55 bg-background/45 p-3">
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                    Tasks
                  </h3>
                  {goal.tasks.length > 0 ? (
                    <TaskTree tasks={goal.tasks} />
                  ) : (
                    <p className="text-sm text-muted-foreground/70">No ## Tasks items yet.</p>
                  )}
                </div>
              </section>
            ))}
          </div>
        </main>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const cloudEnabled = hasCloudPublicConfig();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect an environment to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {cloudEnabled
                  ? "Sign in to T3 Connect to connect a linked environment through its managed tunnel, or add a reachable backend manually."
                  : "Add a reachable backend manually to start working from this browser."}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<Link to="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  {cloudEnabled ? "Open Connections" : "Add environment"}
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
