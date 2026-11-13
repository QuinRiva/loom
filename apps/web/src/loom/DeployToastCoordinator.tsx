import { useAtomValue } from "@effect/atom-react";
import type { ToastManagerAddOptions } from "@base-ui/react/toast";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deployWords, type DeployToastWords } from "@t3tools/client-runtime/state/loom/deploy";
import type {
  EnvironmentId,
  LoomDeployChange,
  LoomDeployEvent,
  LoomDeployNotice,
  LoomDeployStatus,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { type ThreadToastData, toastManager } from "~/components/ui/toast";
import { environmentSummaries } from "~/state/presentation";
import { buildThreadRouteParams } from "~/threadRoutes";

import { claimDeployNotice, deployListView, deployNoticeIsQuiet } from "./deployToast";
import { deployClock, useLoomDeploy } from "./LoomDeployRow";

type OpenThread = (threadId: ThreadId) => void;
type DeployToast = ToastManagerAddOptions<ThreadToastData>;

const RESTART_REASON = {
  deploy: "A new version is being deployed.",
  rollback: "The current version is being rolled back.",
  restart: "An operator is restarting it.",
} as const;

/** How long after the restart warning a client says Loom has not come back. */
const NOT_BACK_MS = 3 * 60_000;

/**
 * loom: deploy toasts (plans/loom-deploy-redesign §4.3): the start warning everyone sees from the
 * press, its retraction, the restart warning, and the notice the restarted server sends each
 * browser once, with the watch's outcome on it.
 */
export function DeployToastCoordinator() {
  return useAtomValue(environmentSummaries.environmentIdsAtom).map((environmentId) => (
    <EnvironmentDeployToasts key={environmentId} environmentId={environmentId} />
  ));
}

function EnvironmentDeployToasts({ environmentId }: { environmentId: EnvironmentId }) {
  const state = useLoomDeploy(environmentId);
  const navigate = useNavigate();
  const shown = useRef<{
    warning: { startedAt: string; toastId: string } | null;
    notice: { noticeId: string; toastId: string } | null;
    lastStatus: LoomDeployStatus | null;
  }>({ warning: null, notice: null, lastStatus: null });
  const restarting = state?.restarting ?? null;
  const deployable = state?.available != null;
  const status = state?.status ?? null;
  const notice = state?.notice ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a restart warning from the server stream is an imperative toast, then a timer until Loom answers again
  useEffect(() => {
    if (restarting === null) return;
    toastManager.add(restartingToast(restarting));
    if (!deployable) return;
    let notBack: string | null = null;
    const timer = window.setTimeout(() => {
      notBack = toastManager.add({
        type: "error",
        title: "Loom has not come back",
        description: "loom-deploy status over SSH shows why.",
        timeout: 0,
        data: { hideCopyButton: true },
      });
    }, NOT_BACK_MS);
    // A reconnect starts a fresh state with no restart warning, which lands here.
    return () => {
      window.clearTimeout(timer);
      if (notBack !== null) toastManager.close(notBack);
    };
  }, [restarting, deployable]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each status from the server stream updates the start warning and the toasts that follow it
  useEffect(() => {
    if (state === null || status === null) return;
    const words = deployWords(state, deployClock);
    const { warning, lastStatus } = shown.current;
    shown.current.lastStatus = status;
    if (words.toast?.kind === "warning") {
      if (warning?.startedAt === status.startedAt)
        toastManager.update(warning.toastId, startToast(words.toast));
      else
        shown.current.warning = {
          startedAt: status.startedAt,
          toastId: toastManager.add(startToast(words.toast)),
        };
    } else if (warning?.startedAt === status.startedAt) {
      toastManager.close(warning.toastId);
      shown.current.warning = null;
      if (words.toast?.kind === "called-off") toastManager.add(startToast(words.toast));
    }
    // Only a fault seen arriving: a page opened later reads it on the row.
    if (
      words.bridgeFault !== null &&
      lastStatus?.id === status.id &&
      lastStatus.bridge !== "fault"
    ) {
      toastManager.add({
        type: "warning",
        title: "Slack is not connected",
        description: words.bridgeFault,
        timeout: 0,
        data: { hideCopyButton: true },
      });
    }
  }, [state, status]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows the startup notice once per browser and keeps its watch line current
  useEffect(() => {
    if (state === null || notice === null) return;
    const words = deployWords(state, deployClock);
    const ours = status !== null && status.id === notice.release.id;
    const open: OpenThread = (threadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      });
    const options = noticeToast(notice, open, {
      watchLine: ours ? words.watchLine : null,
      putBackReason: ours ? words.putBackReason : null,
    });
    const held = shown.current.notice;
    if (held?.noticeId === notice.id) toastManager.update(held.toastId, options);
    else if (claimDeployNotice(window.localStorage, environmentId, notice, Date.now())) {
      shown.current.notice = { noticeId: notice.id, toastId: toastManager.add(options) };
    }
  }, [environmentId, state, status, notice, navigate]);

  return null;
}

const startToast = (words: DeployToastWords): DeployToast => ({
  type: words.kind === "warning" ? "warning" : "info",
  title: words.title,
  description: words.description,
  timeout: 0,
  data: { hideCopyButton: true },
});

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

function noticeToast(
  notice: LoomDeployNotice,
  open: OpenThread,
  watch: { readonly watchLine: string | null; readonly putBackReason: string | null },
): DeployToast {
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
          : watch.putBackReason !== null
            ? `Release ${notice.release.id} was put back: ${watch.putBackReason} Loom is back on ${restored}.`
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
    description: (
      <>
        {notice.headline ??
          (quiet
            ? "Everything in this update is behind the scenes."
            : `${notice.changes.length} pull requests landed.`)}
        {watch.watchLine === null ? null : <span className="mt-1 block">{watch.watchLine}</span>}
      </>
    ),
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
          <div className="mt-1.5 text-xs font-medium text-muted-foreground">{section.heading}</div>
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
