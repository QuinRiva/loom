import { createFileRoute, redirect } from "@tanstack/react-router";
import type { AccountUsageWindowKind } from "@t3tools/contracts";

import { UsageDashboardPage } from "../components/usage/UsageDashboardPage";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

export interface UsageSearch {
  /** Selected usage window; omitted means the 5-hour (primary) window. */
  window?: "secondary";
  /** Meter scope key (`providerInstanceId ?? providerName`) or "all"; omitted lets the server pick. */
  scope?: string;
}

function UsageRouteView() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const windowKind: AccountUsageWindowKind = search.window ?? "primary";

  const setSearch = (update: (current: UsageSearch) => UsageSearch) =>
    void navigate({ search: update, replace: true });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "border-b border-border px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron && "drag-region flex h-[52px] shrink-0 items-center border-b px-5 py-0",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
            <span className="text-sm font-medium text-foreground">Usage</span>
          </div>
        </header>
        <div className="scrollbar-gutter-both flex-1 overflow-y-auto p-4 sm:p-6">
          <UsageDashboardPage
            windowKind={windowKind}
            scope={search.scope}
            onWindowChange={(kind) =>
              setSearch(({ window: _window, ...rest }) =>
                kind === "secondary" ? { ...rest, window: "secondary" } : rest,
              )
            }
            onScopeChange={(scope) => setSearch((current) => ({ ...current, scope }))}
          />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/usage")({
  validateSearch: (search: Record<string, unknown>): UsageSearch => ({
    ...(search.window === "secondary" ? { window: "secondary" as const } : {}),
    ...(typeof search.scope === "string" && search.scope.length > 0 ? { scope: search.scope } : {}),
  }),
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: UsageRouteView,
});
