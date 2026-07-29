import { describe, expect, it } from "vite-plus/test";
import type { ThreadId } from "@t3tools/contracts";

import {
  deriveHandoffReceiptState,
  deriveHandoffReceiptToastPushes,
  deriveHandoffReceiptViews,
  HANDOFF_DRAFTER_APPEARANCE_GRACE_MS,
  type HandoffDrafterShell,
  type HandoffReceiptState,
  type HandoffReceiptView,
} from "./handoffReceipts.logic";
import type { HandoffReceipt } from "./handoffReceiptStore";

const DRAFTER_ID = "drafter-1" as ThreadId;
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const CREATED_AT_MS = Date.parse(CREATED_AT);

const receipt = (overrides: Partial<HandoffReceipt> = {}): HandoffReceipt => ({
  id: "handoff_1",
  sourceThreadKey: "env:thread-1",
  explanation: "the retry logic in FooService is broken, out of scope here",
  createdAt: CREATED_AT,
  drafterThreadId: DRAFTER_ID,
  failure: null,
  ...overrides,
});

const drafterShell = (overrides: Partial<HandoffDrafterShell> = {}): HandoffDrafterShell => ({
  id: DRAFTER_ID,
  archivedAt: null,
  attention: [],
  ...overrides,
});

describe("deriveHandoffReceiptState", () => {
  it("is dispatching until intake acknowledges", () => {
    expect(
      deriveHandoffReceiptState({
        receipt: receipt({ drafterThreadId: null }),
        drafterShell: null,
        nowMs: CREATED_AT_MS,
      }),
    ).toBe("dispatching");
  });

  it("is failed when intake itself rejected the handoff", () => {
    expect(
      deriveHandoffReceiptState({
        receipt: receipt({ drafterThreadId: null, failure: "Source thread is busy." }),
        drafterShell: null,
        nowMs: CREATED_AT_MS,
      }),
    ).toBe("failed");
  });

  it("is drafting while the drafter is alive and healthy", () => {
    expect(
      deriveHandoffReceiptState({
        receipt: receipt(),
        drafterShell: drafterShell(),
        nowMs: CREATED_AT_MS + 2_000,
      }),
    ).toBe("drafting");
  });

  it("is failed when the settlement reactor raised attention on the drafter", () => {
    expect(
      deriveHandoffReceiptState({
        receipt: receipt(),
        drafterShell: drafterShell({ attention: ["needs_guidance"] }),
        nowMs: CREATED_AT_MS + 2_000,
      }),
    ).toBe("failed");
  });

  it("is settled once the drafter is archived", () => {
    expect(
      deriveHandoffReceiptState({
        receipt: receipt(),
        drafterShell: drafterShell({ archivedAt: "2026-01-01T00:00:20.000Z" }),
        nowMs: CREATED_AT_MS + 20_000,
      }),
    ).toBe("settled");
  });

  it("does not read the replay gap right after intake as success", () => {
    // A just-created drafter is briefly absent from the shell snapshot. Calling
    // that success would flash a false "handed off" on every healthy handoff.
    expect(
      deriveHandoffReceiptState({
        receipt: receipt(),
        drafterShell: null,
        nowMs: CREATED_AT_MS + HANDOFF_DRAFTER_APPEARANCE_GRACE_MS - 1,
      }),
    ).toBe("drafting");
  });

  it("reads a settled drafter dropping out of the snapshot as success", () => {
    // A settled drafter is archived, and archived threads are filtered out of
    // the shell snapshot — "disappeared" is the normal healthy ending.
    expect(
      deriveHandoffReceiptState({
        receipt: receipt(),
        drafterShell: null,
        nowMs: CREATED_AT_MS + HANDOFF_DRAFTER_APPEARANCE_GRACE_MS + 1,
      }),
    ).toBe("settled");
  });
});

describe("deriveHandoffReceiptViews", () => {
  it("shows the explanation verbatim and supplies a reason in the failed state", () => {
    const [view] = deriveHandoffReceiptViews({
      receipts: [receipt()],
      drafterShellsById: new Map([[DRAFTER_ID, drafterShell({ attention: ["needs_guidance"] })]]),
      nowMs: CREATED_AT_MS + 30_000,
    });

    expect(view?.state).toBe("failed");
    expect(view?.explanation).toBe(receipt().explanation);
    expect(view?.failureReason).toContain("no goal was created");
  });

  it("prefers the dispatch error over the generic drafter reason", () => {
    const [view] = deriveHandoffReceiptViews({
      receipts: [receipt({ drafterThreadId: null, failure: "Source thread is busy." })],
      drafterShellsById: new Map(),
      nowMs: CREATED_AT_MS,
    });

    expect(view?.failureReason).toBe("Source thread is busy.");
  });

  it("carries no failure reason once settled", () => {
    const [view] = deriveHandoffReceiptViews({
      receipts: [receipt()],
      drafterShellsById: new Map([
        [DRAFTER_ID, drafterShell({ archivedAt: "2026-01-01T00:00:20.000Z" })],
      ]),
      nowMs: CREATED_AT_MS + 20_000,
    });

    expect(view?.state).toBe("settled");
    expect(view?.failureReason).toBeNull();
  });
});

describe("deriveHandoffReceiptToastPushes", () => {
  const view = (overrides: Partial<HandoffReceiptView> = {}): HandoffReceiptView => ({
    id: "handoff_1",
    sourceThreadKey: "env:thread-1",
    state: "settled",
    explanation: "the retry logic in FooService is broken",
    createdAt: CREATED_AT,
    drafterThreadId: DRAFTER_ID,
    failureReason: null,
    ...overrides,
  });
  const previous = (state: HandoffReceiptState) =>
    new Map<string, HandoffReceiptState>([["handoff_1", state]]);

  it("announces a failure seen for the first time, with no in-flight observation", () => {
    // A rejected dispatch can settle in the same commit as the submission, so
    // requiring a prior state would swallow the failure entirely.
    expect(
      deriveHandoffReceiptToastPushes({
        previousStates: new Map(),
        views: [view({ state: "failed", failureReason: "Source thread is busy." })],
        activeThreadKey: "env:thread-1",
      }),
    ).toEqual([expect.objectContaining({ kind: "failure" })]);
  });

  it("does not announce a success seen for the first time", () => {
    expect(
      deriveHandoffReceiptToastPushes({
        previousStates: new Map(),
        views: [view()],
        activeThreadKey: "env:thread-2",
      }),
    ).toEqual([]);
  });

  it("pushes failure even while the source thread is on screen", () => {
    const pushes = deriveHandoffReceiptToastPushes({
      previousStates: previous("drafting"),
      views: [view({ state: "failed", failureReason: "no goal" })],
      activeThreadKey: "env:thread-1",
    });

    expect(pushes).toEqual([
      expect.objectContaining({
        receiptId: "handoff_1",
        kind: "failure",
        failureReason: "no goal",
      }),
    ]);
  });

  it("does not double-notify success while the receipt is on screen", () => {
    expect(
      deriveHandoffReceiptToastPushes({
        previousStates: previous("drafting"),
        views: [view()],
        activeThreadKey: "env:thread-1",
      }),
    ).toEqual([]);
  });

  it("pushes success once the human has navigated away from the source", () => {
    const pushes = deriveHandoffReceiptToastPushes({
      previousStates: previous("drafting"),
      views: [view()],
      activeThreadKey: "env:thread-2",
    });

    expect(pushes).toEqual([expect.objectContaining({ receiptId: "handoff_1", kind: "success" })]);
  });

  it("does not repeat a push while the state is unchanged", () => {
    expect(
      deriveHandoffReceiptToastPushes({
        previousStates: previous("settled"),
        views: [view()],
        activeThreadKey: null,
      }),
    ).toEqual([]);
  });

  it("never pushes for an in-flight transition", () => {
    expect(
      deriveHandoffReceiptToastPushes({
        previousStates: previous("dispatching"),
        views: [view({ state: "drafting" })],
        activeThreadKey: null,
      }),
    ).toEqual([]);
  });
});
