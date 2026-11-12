/**
 * Loom's deploy, as a client sees it (plans/loom-deploy-redesign §4.3): the subscription's events
 * folded into one state, and the words every client shows for it, so the Settings row and the
 * toasts cannot drift.
 */
import type { LoomDeployEvent, LoomDeployNotice, LoomDeployStatus } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentSupervisor } from "../../connection/supervisor.ts";
import { nudgeReconnectDuringUpdateRestart } from "../server.ts";

type Available = Extract<LoomDeployEvent, { type: "available" }>;
type Restarting = Extract<LoomDeployEvent, { type: "restarting" }>;

export interface LoomDeployState {
  /** Null on a server that cannot deploy itself: no row, no palette action. */
  readonly available: Omit<Available, "type"> | null;
  readonly status: LoomDeployStatus | null;
  readonly notice: LoomDeployNotice | null;
  readonly restarting: Restarting | null;
}

const EMPTY: LoomDeployState = { available: null, status: null, notice: null, restarting: null };

/** A status sent again (after a reconnect) or out of order keeps the state as it is. */
export function foldDeployEvent(state: LoomDeployState, event: LoomDeployEvent): LoomDeployState {
  switch (event.type) {
    case "available":
      return { ...state, available: event };
    case "notice":
      return { ...state, notice: event.notice };
    case "restarting":
      return { ...state, restarting: event };
    case "status": {
      const held = state.status;
      return held !== null &&
        held.id === event.status.id &&
        Date.parse(event.status.at) <= Date.parse(held.at)
        ? state
        : { ...state, status: event.status };
    }
  }
}

/**
 * The subscription's events folded per connection: a reconnect starts from nothing, and the server
 * sends everything again. A restart warning also nudges the reconnect for three minutes, so the
 * client is back within a second of Loom answering instead of waiting out its back-off.
 */
export const foldDeployEvents = <E, R>(events: Stream.Stream<LoomDeployEvent, E, R>) =>
  events.pipe(
    Stream.tap((event) =>
      event.type !== "restarting"
        ? Effect.void
        : EnvironmentSupervisor.pipe(
            Effect.flatMap((supervisor) =>
              nudgeReconnectDuringUpdateRestart({
                stateChanges: SubscriptionRef.changes(supervisor.state),
                retryNow: supervisor.retryNow,
              }),
            ),
            Effect.timeoutOption(Duration.minutes(3)),
            Effect.forkDetach,
          ),
    ),
    Stream.scan(() => EMPTY, foldDeployEvent),
    Stream.drop(1),
  );

const short = (sha: string) => sha.slice(0, 7);

/** "about 2½ minutes", to the nearest half minute. */
export function roughDuration(seconds: number): string {
  if (seconds < 45) return "under a minute";
  const halves = Math.round(seconds / 30);
  const whole = Math.floor(halves / 2);
  return halves === 2 ? "about 1 minute" : `about ${whole}${halves % 2 === 1 ? "½" : ""} minutes`;
}

const startedBy = (status: LoomDeployStatus) =>
  `Started ${status.who === null ? "" : `by ${status.who} `}from ${
    { loom: "Loom", cli: "the command line", slack: "Slack" }[status.origin]
  }.`;

/** A start warning, or the retraction that replaces it. */
export interface DeployToastWords {
  readonly kind: "warning" | "called-off";
  readonly title: string;
  readonly description: string;
}

export interface DeployWords {
  /** The Settings row; null on a server that cannot deploy itself. */
  readonly row: { readonly text: string; readonly action: "deploy" | "cancel" | null } | null;
  /** The toast everyone sees from the press until the switch, or its retraction. */
  readonly toast: DeployToastWords | null;
  /** The line under "Loom updated" for the release being watched. */
  readonly watchLine: string | null;
  /** Why the release was put back, for the "Loom rolled back" toast. */
  readonly putBackReason: string | null;
  /** Slack not connected after a deploy that did not come from Slack. */
  readonly bridgeFault: string | null;
}

/** The words for every status; `clock` renders a time ("2:32 pm"). */
export function deployWords(state: LoomDeployState, clock: (iso: string) => string): DeployWords {
  const { available, status, notice } = state;
  const sinceOf = (releaseId: string) =>
    notice !== null && notice.release.id === releaseId ? ` since ${clock(notice.at)}` : "";
  const idle =
    available === null
      ? ""
      : `Running ${short(available.release.sha)}${sinceOf(available.release.id)}. Builds main and restarts Loom in ${roughDuration(available.stopAfterSeconds)}.`;
  const downAt = status?.stopAt == null ? "in a few minutes" : `at around ${clock(status.stopAt)}`;
  const watchProblem =
    status?.phase === "watching" && status.reason !== null
      ? `The watch found a problem: ${status.reason} ${status.noReturn ? "Nothing is put back on this deploy." : "Putting the previous release back."}`
      : null;

  const rowText = (() => {
    switch (status?.phase) {
      case undefined:
      case "live":
        return idle;
      case "building":
        return `Building ${short(status.sha)}. Down ${downAt}. ${startedBy(status)}`;
      case "checking":
        return "Checking the new release on your settings.";
      case "switching":
        return "Switching now.";
      case "watching":
        return (
          watchProblem ??
          `On the new release${sinceOf(status.id)}.${status.watchUntil === null ? "" : ` Watched until ${clock(status.watchUntil)}.`}`
        );
      case "called-off":
        return `The last deploy was called off: ${status.reason ?? "no reason given."} ${idle}`;
      case "put-back":
        return `The last deploy was put back: ${status.reason ?? "no reason given."} ${idle}`;
      case "held":
        return status.reason ?? "Held for a fix: loom-deploy retry, or loom-deploy back.";
    }
  })();
  const running = status?.phase === "building" || status?.phase === "checking";
  const settled =
    status === null ||
    status.phase === "live" ||
    status.phase === "called-off" ||
    status.phase === "put-back";

  return {
    row:
      available === null
        ? null
        : { text: rowText, action: running ? "cancel" : settled ? "deploy" : null },
    toast:
      status === null
        ? null
        : running
          ? {
              kind: "warning",
              title: "Loom is being updated",
              description: `It goes down for about 40 seconds ${downAt}. Running agent turns are interrupted and resume when it is back. ${startedBy(status)}`,
            }
          : status.phase === "called-off"
            ? {
                kind: "called-off",
                title: "The update was called off",
                description: `${status.reason ?? ""} Loom was not stopped.`.trim(),
              }
            : null,
    watchLine:
      status?.phase === "live"
        ? "Live."
        : status?.phase !== "watching"
          ? null
          : (watchProblem ??
            (status.watchUntil === null
              ? null
              : `Being watched until ${clock(status.watchUntil)}; ${status.noReturn ? "nothing goes back by itself on this deploy." : "it goes back by itself if Loom fails."}`)),
    putBackReason: status?.phase === "put-back" ? status.reason : null,
    bridgeFault:
      status !== null &&
      status.bridge === "fault" &&
      status.origin !== "slack" &&
      (status.phase === "watching" || status.phase === "live")
        ? "Slack is not connected after this update. Loom was left on the new release."
        : null,
  };
}
