import {
  type LoomThreadShellFields,
  type OrchestrationV2ThreadShell,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { workstreamFields, workstreamShell } from "./loomTestFixtures.ts";
import {
  buildNodeContextMenuItems,
  buildWorkstreamNodes,
  describeOutcomeVerdict,
  getActivity,
  getGateWaitLabel,
} from "./workstreamNodes.ts";

const AT = "2026-10-05T09:00:00.000Z";
const started = { kickoffAt: AT };
const outcomeRecord = (
  outcome: string,
  decision: "terminal" | "loop" | "yield",
  synthesised = false,
) => ({
  outcome,
  decision,
  round: decision === "loop" ? 1 : 0,
  ...(synthesised ? { synthesised: true } : {}),
  eventId: null,
  at: AT,
});
const id = ThreadId.make;
const T = {
  root: id("root"),
  held: id("held"),
  blocked: id("blocked"),
  unbriefed: id("unbriefed"),
  ready: id("ready"),
  gateCoder: id("gate-coder"),
  gateReviewer: id("gate-reviewer"),
  coderDone: id("coder-done"),
  cancelled: id("cancelled"),
  quiescent: id("quiescent"),
  awaitingInput: id("awaiting-input"),
};
const thread = (
  threadId: ThreadId,
  fields: Partial<LoomThreadShellFields> = {},
  shellFields: Partial<OrchestrationV2ThreadShell> = {},
) => workstreamShell(workstreamFields(threadId, fields), shellFields);

const shells = {
  root: thread(T.root, { parentThreadId: null, role: null, kickoffBriefPath: null, ...started }),
  held: thread(T.held, { held: true, heldSince: AT }),
  blocked: thread(T.blocked, { blockedBy: [T.quiescent] }),
  unbriefed: thread(T.unbriefed, { kickoffBriefPath: null }),
  ready: thread(T.ready),
  gateCoder: thread(
    T.gateCoder,
    {
      ...started,
      pendingRework: true,
      lastOutcome: outcomeRecord("done", "terminal"),
      reportPath: `/reports/${T.gateCoder}.md`,
    },
    { activityRunStatus: "running", status: "running" },
  ),
  gateReviewer: thread(T.gateReviewer, {
    ...started,
    role: "reviewer",
    blockedBy: [T.gateCoder],
    routes: [
      { on: ["needs_rework"], kind: "loop", to: T.gateCoder, maxRounds: 2 },
      { on: ["clean"], kind: "resolve" },
    ],
    gateRounds: 1,
    lastOutcome: {
      ...outcomeRecord("needs_rework", "loop"),
      counts: { mustFix: 2, niceToHave: 1 },
    },
    reportPath: `/reports/${T.gateReviewer}.md`,
  }),
  coderDone: thread(T.coderDone, {
    ...started,
    outcome: "done",
    outcomeAt: AT,
    lastOutcome: outcomeRecord("done", "terminal"),
    reportPath: `/reports/${T.coderDone}.md`,
  }),
  cancelled: thread(T.cancelled, { ...started, outcome: "cancelled", outcomeAt: AT }),
  quiescent: thread(T.quiescent, {
    ...started,
    role: "researcher",
    attention: ["awaiting_orchestrator"],
    lastOutcome: outcomeRecord("quiescent", "yield", true),
    reportPath: `/reports/${T.quiescent}.quiescent-run-1.md`,
  }),
  awaitingInput: thread(T.awaitingInput, started, {
    activityRunStatus: "waiting",
    status: "waiting",
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("loom-ask:test"),
      kind: "user_input",
      createdAt: DateTime.makeUnsafe(AT),
      header: "Parser",
    },
  }),
};

const nodes = buildWorkstreamNodes(Object.values(shells));
const node = (threadId: ThreadId) => nodes.get(threadId)!;
const patch = (
  shell: OrchestrationV2ThreadShell,
  fields: Partial<LoomThreadShellFields>,
  shellFields: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...shell,
  ...shellFields,
  workstream: { ...shell.workstream!, ...fields },
});

describe("buildWorkstreamNodes", () => {
  it("derives every plan column", () => {
    expect(node(T.held).column).toBe("held");
    expect(node(T.blocked).column).toBe("blocked");
    expect(node(T.unbriefed).column).toBe("blocked");
    expect(node(T.ready).column).toBe("ready");
    expect(node(T.gateCoder).column).toBe("in_progress");
    expect(node(T.coderDone).column).toBe("done");
    expect(node(T.cancelled).column).toBe("cancelled");
  });

  it("reads attention as stored ∪ derived, highest first", () => {
    expect(node(T.quiescent).reasons).toEqual(["awaiting_orchestrator"]);
    expect(node(T.unbriefed).reasons).toEqual(["brief-needed"]);
    expect(node(T.awaitingInput).reasons).toEqual([]);
  });

  it("names a waiting question and its age on the card (S4)", () => {
    expect(getActivity(node(T.awaitingInput))).toMatch(
      /^waiting for your input · Parser · \d+[smhd]$/,
    );
  });

  it("an archived unfinished dependency still gates; an archived done one releases", () => {
    const archivedAt = shells.root.createdAt;
    const archivedOpen = patch(shells.quiescent, {}, { archivedAt });
    expect(buildWorkstreamNodes([archivedOpen, shells.blocked]).get(T.blocked)!.column).toBe(
      "blocked",
    );
    const archivedDone = patch(shells.quiescent, { outcome: "done" }, { archivedAt });
    expect(buildWorkstreamNodes([archivedDone, shells.blocked]).get(T.blocked)!.column).toBe(
      "ready",
    );
  });
});

describe("outcome controls", () => {
  it("puts accept done and cancel in an open node's menu, reopen in a settled one's, and no release or lane item", () => {
    const ids = buildNodeContextMenuItems(node(T.quiescent)).map((item) => item.id);
    expect(ids).toEqual([
      "open",
      "dispatch",
      "history",
      "report",
      "outcome:done",
      "outcome:cancelled",
      "clear-flags",
    ]);
    expect(buildNodeContextMenuItems(node(T.coderDone)).map((item) => item.id)).toContain(
      "outcome:reopen",
    );
  });
});

describe("the gated pair", () => {
  it("the coder holds the open rework round; the reviewer waits on it", () => {
    expect(getGateWaitLabel(node(T.gateCoder), nodes)).toEqual({
      label: "reworking round 1",
      word: "reworking ⟲1",
      active: true,
    });
    expect(getGateWaitLabel(node(T.gateReviewer), nodes)).toEqual({
      label: "waiting on rework",
      word: "waiting ⟲1",
      active: false,
    });
  });

  it("describes verdicts", () => {
    expect(describeOutcomeVerdict({ outcome: "needs_rework", decision: "loop", round: 1 })).toEqual(
      { label: "needs rework ⟲1", tone: "warning" },
    );
    expect(
      describeOutcomeVerdict({ outcome: "quiescent", decision: "yield", round: 0 })?.tone,
    ).toBe("info");
    expect(describeOutcomeVerdict({ outcome: "done", decision: "terminal", round: 0 })).toBeNull();
  });
});
