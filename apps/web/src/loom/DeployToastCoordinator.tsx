import { useAtomValue } from "@effect/atom-react";
import type { ToastManagerAddOptions } from "@base-ui/react/toast";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  LoomDeployChange,
  LoomDeployEvent,
  LoomDeployNotice,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { type ThreadToastData, toastManager } from "~/components/ui/toast";
import { useEnvironmentIds } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";

import { claimDeployNotice, deployListView, deployNoticeIsQuiet } from "./deployToast";
import { loomCommands } from "./loomGoalState";

type OpenThread = (threadId: ThreadId) => void;
type DeployToast = ToastManagerAddOptions<ThreadToastData>;

const RESTART_REASON = {
  deploy: "A new version is being deployed.",
  rollback: "The current version is being rolled back.",
  restart: "An operator is restarting it.",
} as const;

/**
 * loom: deploy toasts (plans/deploy-toasts/plan.mdx in loom-slack-bridge): the warning deployctl
 * posts before it stops Loom, and the notice the restarted server sends each browser once.
 */
export function DeployToastCoordinator() {
  return useEnvironmentIds().map((environmentId) => (
    <EnvironmentDeployToasts key={environmentId} environmentId={environmentId} />
  ));
}

function EnvironmentDeployToasts({ environmentId }: { environmentId: EnvironmentId }) {
  const event = Option.getOrNull(
    AsyncResult.value(useAtomValue(loomCommands.deploy({ environmentId, input: {} }))),
  );
  const navigate = useNavigate();

  useEffect(() => {
    if (event === null) return;
    if (event.type === "restarting") {
      toastManager.add(restartingToast(event));
      return;
    }
    if (!claimDeployNotice(window.localStorage, environmentId, event.notice, Date.now())) return;
    const open: OpenThread = (threadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      });
    toastManager.add(noticeToast(event.notice, open));
  }, [environmentId, event, navigate]);

  return null;
}

const restartingToast = (event: Extract<LoomDeployEvent, { type: "restarting" }>): DeployToast => ({
  type: "warning",
  title: "Loom is about to restart",
  description: `${RESTART_REASON[event.reason]} Running agent turns will be interrupted and resume when Loom is back.`,
  timeout: 20_000,
  data: { hideCopyButton: true },
});

const prCount = (count: number) => (
  <span className="ms-1.5 text-xs font-normal text-muted-foreground">
    {count === 1 ? "1 PR" : `${count} PRs`}
  </span>
);

function noticeToast(notice: LoomDeployNotice, open: OpenThread): DeployToast {
  const list =
    notice.changes.length === 0
      ? {}
      : { expandableContent: <DeployChangeList changes={notice.changes} open={open} /> };
  if (notice.kind === "rolled-back") {
    const restored = notice.restored?.id ?? "the previous release";
    const lost =
      notice.lostSince === null
        ? ""
        : ` Anything done in Loom after ${new Date(notice.lostSince).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} was lost.`;
    return {
      type: "error",
      title: "Loom rolled back",
      description:
        (notice.reason === "manual"
          ? `An operator rolled Loom back from ${notice.release.id} to ${restored}.`
          : `Release ${notice.release.id} failed its health check; Loom is back on ${restored}.`) +
        lost,
      timeout: 0,
      data: {
        hideCopyButton: true,
        ...list,
        expandableLabels: { expand: "What was rolled back", collapse: "Hide" },
      },
    };
  }
  const quiet = deployNoticeIsQuiet(notice.changes);
  return {
    type: "success",
    title: (
      <>
        Loom updated
        {prCount(notice.changes.length)}
      </>
    ),
    description:
      notice.headline ??
      (quiet
        ? "Everything in this update is behind the scenes."
        : `${notice.changes.length} pull requests landed.`),
    timeout: 0,
    data: {
      ...(quiet ? { dismissAfterVisibleMs: 8_000 } : {}),
      ...list,
      expandableLabels: { expand: "What's in it", collapse: "Hide" },
    },
  };
}

function DeployChangeList({
  changes,
  open,
}: {
  changes: ReadonlyArray<LoomDeployChange>;
  open: OpenThread;
}) {
  const [showAll, setShowAll] = useState(false);
  const { sections, hidden } = deployListView(changes, showAll);
  const trimmed = showAll || hidden > 0;
  return (
    <div className="flex flex-col gap-0.5 border-t border-border pt-1.5 text-xs">
      {sections.map((section) => (
        <div key={section.heading} className="flex flex-col gap-0.5">
          <div className="mt-1.5 text-2xs tracking-wide text-muted-foreground uppercase">
            {section.heading}
          </div>
          {section.changes.map((change) => (
            <div key={change.pr} className="flex gap-2 py-0.5">
              {change.threadId === null ? (
                <a
                  className="w-9 shrink-0 font-mono text-primary hover:underline"
                  href={change.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  #{change.pr}
                </a>
              ) : (
                <button
                  className="w-9 shrink-0 cursor-pointer text-left font-mono text-primary hover:underline"
                  onClick={() => open(change.threadId!)}
                  type="button"
                >
                  #{change.pr}
                </button>
              )}
              <span className="min-w-0">
                {change.summary ?? change.title}
                {change.threadId === null ? (
                  <span className="ms-1 text-muted-foreground">(GitHub)</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ))}
      {hidden > 0 ? <div className="ps-11 text-muted-foreground">+ {hidden} more</div> : null}
      {trimmed ? (
        <button
          className="mt-1 self-end cursor-pointer text-muted-foreground hover:text-foreground"
          onClick={() => setShowAll(!showAll)}
          type="button"
        >
          {showAll ? "Show fewer" : `See all ${changes.length}`}
        </button>
      ) : null}
    </div>
  );
}
