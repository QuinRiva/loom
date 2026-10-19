/**
 * loom: the hub login reminder's Log in… dialog, mounted once at the root and
 * opened through `useHubLoginStore().openDialog` by the composer banner and the
 * Usage page. It runs cliproxy's own OAuth flow on the environment's server:
 * the server mints a claude.ai sign-in URL on the hub, the user signs in (or
 * sends the link to the account's owner), and pastes back what claude.ai shows.
 * The browser only ever talks to Loom and claude.ai, so it works remotely.
 */
import { useAtomValue } from "@effect/atom-react";
import type { UsageLimitSourceLoginStartResult } from "@t3tools/contracts";
import {
  hubAccountLogin,
  type LoginAlert,
  loginAttentionText,
  reloginDueDay,
} from "@t3tools/shared/usageLimits";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { environmentPresentations } from "~/state/presentation";
import { useAtomCommand } from "~/state/use-atom-command";

import { useHubLoginStore } from "./hubLoginStore";
import { loomCommands } from "./loomGoalState";

export function HubLoginDialogHost() {
  const alert = useHubLoginStore((state) => state.dialog);
  const openDialog = useHubLoginStore((state) => state.openDialog);
  return (
    <Dialog open={alert !== null} onOpenChange={(open) => (open ? undefined : openDialog(null))}>
      <DialogPopup>
        {alert ? (
          // Keyed per account: a fresh sign-in link and an empty paste each time.
          <HubLoginFlow key={`${alert.environmentId}:${alert.email}`} alert={alert} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

const failureText = (cause: unknown, fallback: string) =>
  typeof cause === "object" && cause !== null && "error" in cause && cause.error instanceof Error
    ? cause.error.message
    : fallback;

function HubLoginFlow({ alert }: { readonly alert: LoginAlert }) {
  const start = useAtomCommand(loomCommands.hubLoginStart, { reportFailure: false });
  const finish = useAtomCommand(loomCommands.hubLoginFinish, { reportFailure: false });
  const close = () => useHubLoginStore.getState().openDialog(null);
  const [link, setLink] = useState<UsageLimitSourceLoginStartResult | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Who the hub says signed in: undefined until a login finishes, null when it could not tell.
  const [loggedIn, setLoggedIn] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  // The account's schedule as the hub reads it now, so the text follows a login
  // that reshuffled it (signing in as another pool account moves everyone on).
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const login = hubAccountLogin(presentations, alert.email);
  const [now] = useState(() => Date.now()); // the dialog is short-lived
  const reminder = loginAttentionText(login, alert.name, now);
  const wrongAccount = loggedIn !== undefined && loggedIn !== null && loggedIn !== alert.email;

  // The dialog exists to sign in: mint the link as it opens rather than ask for one more click.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void start({ environmentId: alert.environmentId, input: { sourceId: alert.sourceId } }).then(
      (result) => {
        if (!live) return;
        if (result._tag === "Success") setLink(result.value);
        else setError(failureText(result.cause, "The hub could not start a sign-in."));
      },
    );
    return () => {
      live = false;
    };
  }, [start, alert.environmentId, alert.sourceId, attempt]);

  const retry = () => {
    setLink(null);
    setPasted("");
    setCopied(false);
    setError(null);
    setLoggedIn(undefined);
    setAttempt((count) => count + 1);
  };

  const submit = async () => {
    if (!link || pasted.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const result = await finish({
      environmentId: alert.environmentId,
      input: { sourceId: alert.sourceId, state: link.state, pasted: pasted.trim() },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failureText(result.cause, "The login did not finish."));
      return;
    }
    setLoggedIn(result.value.loggedIn);
  };

  const dueDay = login ? reloginDueDay(login, now) : null;
  const outcome =
    loggedIn === undefined
      ? null
      : loggedIn === alert.email
        ? { tone: "success", text: `Logged in. ${alert.email}'s clock has restarted.` }
        : loggedIn === null
          ? {
              tone: "warning",
              text: "The hub saved the login, but Loom could not tell which account it was. The reminder updates on the hub's next read.",
            }
          : {
              tone: "warning",
              text: `You signed in as ${loggedIn}, not ${alert.email}, so ${loggedIn}'s clock restarted instead. ${
                reminder
                  ? `${alert.email} still needs logging in: ${reminder}`
                  : `That moved the schedule on: ${alert.name} is ${dueDay ? `next due by ${dueDay}` : "not due now"}.`
              }`,
            };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Log in to {alert.email}</DialogTitle>
        {outcome || !reminder ? null : <DialogDescription>{reminder}</DialogDescription>}
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-4">
          {outcome ? (
            <>
              <p
                role="status"
                className={
                  outcome.tone === "success" ? "text-sm text-success" : "text-sm text-warning"
                }
              >
                {outcome.text}
              </p>
              {wrongAccount ? (
                <p className="text-sm text-muted-foreground">
                  To log in {alert.name}
                  {reminder ? "" : " anyway"}, switch claude.ai to {alert.email} (or open the link
                  in a private window), then Try again.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <section className="grid gap-2">
                <span className="text-sm font-medium">
                  1 · Sign in on claude.ai as {alert.email}
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={!link}
                    render={<a href={link?.url} target="_blank" rel="noreferrer" />}
                  >
                    Open sign-in page
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!link}
                    onClick={() => {
                      if (!link) return;
                      void navigator.clipboard.writeText(link.url).then(() => setCopied(true));
                    }}
                  >
                    {copied ? "Copied" : "Copy link"}
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground">
                  The page ends on an unreachable localhost address — that is expected. Copy the
                  code claude.ai shows, or that whole address. Finish within 5 minutes of opening
                  the link.
                </span>
              </section>
              <section className="grid gap-2">
                <span className="text-sm font-medium">2 · Paste the code</span>
                <Input
                  value={pasted}
                  placeholder="code#state, or the address-bar URL"
                  onChange={(event) => setPasted(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void submit();
                  }}
                />
              </section>
            </>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        {outcome ? (
          <>
            <Button size="sm" variant={wrongAccount ? "outline" : "default"} onClick={close}>
              Done
            </Button>
            {wrongAccount ? (
              <Button size="sm" onClick={retry}>
                Try again as {alert.name}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={close}>
              Cancel
            </Button>
            {error && !link ? (
              <Button size="sm" variant="outline" onClick={retry}>
                Try again
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={!link || busy || pasted.trim().length === 0}
              onClick={() => void submit()}
            >
              {busy ? "Finishing…" : "Finish login"}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
