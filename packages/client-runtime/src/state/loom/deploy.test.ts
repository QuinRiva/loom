import type { LoomDeployNotice, LoomDeployStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deployWords, foldDeployEvent, type LoomDeployState, roughDuration } from "./deploy.ts";

const clock = (iso: string) => iso.slice(11, 16);
const status = (patch: Partial<LoomDeployStatus>): LoomDeployStatus => ({
  id: "20261112-031502-ab12cd3",
  sha: "ab12cd3ffff",
  version: "100.20261112.1",
  phase: "building",
  origin: "loom",
  who: "Carl",
  noReturn: false,
  startedAt: "2026-11-12T03:15:02.000Z",
  stopAt: "2026-11-12T03:17:32.000Z",
  watchUntil: null,
  reason: null,
  bridge: null,
  at: "2026-11-12T03:15:02.000Z",
  ...patch,
});
const notice = (releaseId: string): LoomDeployNotice => ({
  id: "n1",
  kind: "updated",
  reason: null,
  at: "2026-11-12T03:18:10.000Z",
  release: { id: releaseId, sha: "ab12cd3ffff" },
  restored: null,
  lostSince: null,
  headline: null,
  changes: [],
});
const running: LoomDeployState = {
  available: {
    release: { id: "20261111-005403-d8e999a", sha: "d8e999aeeee" },
    stopAfterSeconds: 150,
  },
  status: null,
  notice: null,
  restarting: null,
};
const words = (patch: Partial<LoomDeployStatus> | null, extra: Partial<LoomDeployState> = {}) =>
  deployWords({ ...running, status: patch === null ? null : status(patch), ...extra }, clock);

describe("deployWords", () => {
  it("offers Deploy with the estimate when nothing is running", () => {
    expect(words(null).row).toEqual({
      text: "Running d8e999a. Builds main and restarts Loom in about 2½ minutes.",
      action: "deploy",
    });
    expect(words(null).toast).toBeNull();
  });

  it("shows no row on a server that cannot deploy itself", () => {
    expect(words(null, { available: null }).row).toBeNull();
  });

  it("warns everyone from the press with the time Loom goes down", () => {
    const building = words({ phase: "building" });
    expect(building.row).toEqual({
      text: "Building ab12cd3. Down at around 03:17. Started by Carl from Loom.",
      action: "cancel",
    });
    expect(building.toast).toEqual({
      kind: "warning",
      title: "Loom is being updated",
      description:
        "It goes down for about 40 seconds at around 03:17. Running agent turns are interrupted and resume when it is back. Started by Carl from Loom.",
    });
    const checking = words({ phase: "checking", origin: "slack", who: "Jacob" });
    expect(checking.row).toEqual({
      text: "Checking the new release on your settings.",
      action: "cancel",
    });
    expect(checking.toast?.description).toContain("Started by Jacob from Slack.");
  });

  it("replaces the warning when the deploy is called off", () => {
    const off = words({
      phase: "called-off",
      reason: "The new release could not read settings.json.",
    });
    expect(off.toast).toEqual({
      kind: "called-off",
      title: "The update was called off",
      description: "The new release could not read settings.json. Loom was not stopped.",
    });
    expect(off.row?.text).toBe(
      "The last deploy was called off: The new release could not read settings.json. Running d8e999a. Builds main and restarts Loom in about 2½ minutes.",
    );
    expect(off.row?.action).toBe("deploy");
  });

  it("says Switching now with no button", () => {
    expect(words({ phase: "switching" }).row).toEqual({ text: "Switching now.", action: null });
    expect(words({ phase: "switching" }).toast).toBeNull();
  });

  it("reports the watch, then Live", () => {
    const watching = words(
      { phase: "watching", watchUntil: "2026-11-12T03:23:10.000Z" },
      { notice: notice("20261112-031502-ab12cd3") },
    );
    expect(watching.row).toEqual({
      text: "On the new release since 03:18. Watched until 03:23.",
      action: null,
    });
    expect(watching.watchLine).toBe(
      "Being watched until 03:23; it goes back by itself if Loom fails.",
    );
    const live = deployWords(
      {
        available: {
          release: { id: "20261112-031502-ab12cd3", sha: "ab12cd3ffff" },
          stopAfterSeconds: 150,
        },
        status: status({ phase: "live" }),
        notice: notice("20261112-031502-ab12cd3"),
        restarting: null,
      },
      clock,
    );
    expect(live.row).toEqual({
      text: "Running ab12cd3 since 03:18. Builds main and restarts Loom in about 2½ minutes.",
      action: "deploy",
    });
    expect(live.watchLine).toBe("Live.");
  });

  it("names a failed check: put back on a routine deploy, reported on a no-return one", () => {
    const failing = words({ phase: "watching", reason: "Loom stopped answering." });
    expect(failing.watchLine).toBe(
      "The watch found a problem: Loom stopped answering. Putting the previous release back.",
    );
    expect(
      words({ phase: "watching", reason: "Loom stopped answering.", noReturn: true }).row?.text,
    ).toBe(
      "The watch found a problem: Loom stopped answering. Nothing is put back on this deploy.",
    );
  });

  it("gives the reason a release was put back", () => {
    const back = words({ phase: "put-back", reason: "Loom exited during the watch (1)." });
    expect(back.putBackReason).toBe("Loom exited during the watch (1).");
    expect(back.row?.text).toMatch(
      /^The last deploy was put back: Loom exited during the watch \(1\)\./,
    );
    expect(back.row?.action).toBe("deploy");
  });

  it("reports a held release with its reason", () => {
    const reason = "Loom exited (1) and is held for a fix: loom-deploy retry, or loom-deploy back.";
    expect(words({ phase: "held", reason, noReturn: true }).row).toEqual({
      text: reason,
      action: null,
    });
  });

  it("warns of a Slack fault only on a deploy that did not come from Slack", () => {
    expect(words({ phase: "live", bridge: "fault", origin: "loom" }).bridgeFault).toBe(
      "Slack is not connected after this update. Loom was left on the new release.",
    );
    expect(words({ phase: "live", bridge: "fault", origin: "slack" }).bridgeFault).toBeNull();
  });

  it("rounds the estimate to the nearest half minute", () => {
    expect([30, 60, 100, 150, 600].map(roughDuration)).toEqual([
      "under a minute",
      "about 1 minute",
      "about 1½ minutes",
      "about 2½ minutes",
      "about 10 minutes",
    ]);
  });
});

describe("foldDeployEvent", () => {
  it("keeps the latest status when one arrives again or out of order", () => {
    const later = status({ phase: "watching", at: "2026-11-12T03:18:12.000Z" });
    const state = foldDeployEvent(running, { type: "status", status: later });
    expect(foldDeployEvent(state, { type: "status", status: later })).toBe(state);
    expect(foldDeployEvent(state, { type: "status", status: status({}) }).status).toBe(later);
  });
});
