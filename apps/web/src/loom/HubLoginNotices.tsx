/**
 * loom: the Usage page's hub login lines — signed out, refresh failing, re-login
 * overdue or due — each with Log in… (the root-mounted `HubLoginDialogHost`).
 * Not snoozable: the page is where the full picture lives.
 */
import { useAtomValue } from "@effect/atom-react";
import type { LoginAlert } from "@t3tools/shared/usageLimits";
import { AlertTriangleIcon } from "lucide-react";

import { Alert, AlertAction, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

import { useHubLoginStore } from "./hubLoginStore";
import { loomCommands } from "./loomGoalState";

export function HubLoginNotices({ alerts }: { readonly alerts: readonly LoginAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {alerts.map((alert) => (
        <Alert
          key={`${alert.environmentId}:${alert.email}`}
          variant={
            alert.attention === "dead" || alert.attention === "overdue" ? "error" : "warning"
          }
          controlAlignment="first-line"
        >
          <AlertTriangleIcon />
          <AlertTitle className="break-words">{alert.text}</AlertTitle>
          {alert.login.relogin?.kind === "token" ? null : (
            <AlertAction>
              <LogInButton alert={alert} />
            </AlertAction>
          )}
        </Alert>
      ))}
    </div>
  );
}

function LogInButton({ alert }: { readonly alert: LoginAlert }) {
  const canLogIn = useAtomValue(loomCommands.hubLoginStart.permissionAtom(alert.environmentId));
  const openDialog = useHubLoginStore((state) => state.openDialog);
  return (
    <Button size="xs" variant="outline" disabled={!canLogIn} onClick={() => openDialog(alert)}>
      Log in…
    </Button>
  );
}
