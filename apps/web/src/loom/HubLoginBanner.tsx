/**
 * loom: the composer banner for hub logins that need the user, one item per account, most urgent
 * first: signed out, refresh failing, re-login overdue, re-login due. Each offers Log in… and, while
 * only due or failing, Snooze until tomorrow 08:00; a one-year token is re-minted outside Loom, so
 * has no Log in…. Snoozing hides only this banner; the meter and Usage page stay ambient.
 */
import { useAtomValue } from "@effect/atom-react";
import { type LoginAlert, loginAlerts } from "@t3tools/shared/usageLimits";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ComposerBanner } from "~/components/chat/ComposerBanner";
import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { Button } from "~/components/ui/button";
import { environmentPresentations } from "~/state/presentation";

import { nextMorning, useHubLoginStore } from "./hubLoginStore";
import { loomCommands } from "./loomGoalState";

const MINUTE = 60_000;

const urgent = (alert: LoginAlert) => alert.attention === "dead" || alert.attention === "overdue";

/** The banner items, rebuilt as readings land and once a minute (a snooze lapsing). */
export function useHubLoginBannerItems(): ComposerBannerStackItem[] {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const snoozedUntil = useHubLoginStore((state) => state.snoozedUntil);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), MINUTE);
    return () => window.clearInterval(id);
  }, []);
  return loginAlerts(presentations, now)
    .filter((alert) => urgent(alert) || (snoozedUntil[alert.email] ?? 0) <= now)
    .map((alert) => {
      // The first sentence leads; the rest (the expiry, the hub's reason) follows
      // on its own wrapped line, never the stack's one-line description: that
      // truncates, and loses its "details" popover when the actions share the
      // title's line, so the expiry date could vanish.
      const split = alert.text.indexOf(". ");
      return {
        id: `hub-login:${alert.email}`,
        variant: urgent(alert) ? "error" : "warning",
        priority: "urgent",
        icon: <KeyRoundIcon />,
        title: split === -1 ? alert.text : alert.text.slice(0, split),
        ...(split === -1
          ? {}
          : {
              children: (
                <ComposerBanner.Body className="pe-2 pb-1.5 text-muted-foreground">
                  {alert.text.slice(split + 2)}
                </ComposerBanner.Body>
              ),
            }),
        actions: <HubLoginActions alert={alert} />,
      } satisfies ComposerBannerStackItem;
    });
}

function HubLoginActions({ alert }: { readonly alert: LoginAlert }) {
  const canLogIn = useAtomValue(loomCommands.hubLoginStart.permissionAtom(alert.environmentId));
  const openDialog = useHubLoginStore((state) => state.openDialog);
  const snooze = useHubLoginStore((state) => state.snooze);
  return (
    <>
      {alert.login.relogin?.kind !== "token" ? (
        <Button size="xs" variant="ghost" disabled={!canLogIn} onClick={() => openDialog(alert)}>
          Log in…
        </Button>
      ) : null}
      {urgent(alert) ? null : (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => snooze(alert.email, nextMorning(Date.now()))}
        >
          Snooze until tomorrow
        </Button>
      )}
    </>
  );
}
