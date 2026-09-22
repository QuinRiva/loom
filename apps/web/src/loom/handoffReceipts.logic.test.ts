import { describe, expect, it } from "vite-plus/test";
import type { ThreadId } from "@t3tools/contracts";

import {
  deriveHandoffReceiptState,
  deriveHandoffReceiptToastPushes,
  deriveHandoffReceiptViews,
  HANDOFF_DRAFTER_APPEARANCE_GRACE_MS,
  resolveHandoffReceiptShells,
  type HandoffDrafterShell,
  type HandoffReceiptState,
  type HandoffReceiptView,
  type HandoffThreadShell,
} from "./handoffReceipts.logic";
import type { HandoffReceipt } from "./handoffReceiptStore";

const DRAFTER_ID = "drafter-1" as ThreadId;
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const CREATED_AT_MS = Date.parse(CREATED_AT);

// By default, submission and acknowledgement coincide (a fast intake). Tests
// that care about a slow intake set `intake.acknowledgedAt` explicitly.
const receipt = (overrides: Partial<HandoffReceipt> = {}): HandoffReceipt => ({
  id: "handoff_1",
  sourceThreadKey: "env:thread-1",
  explanation: "the retry logic in FooService is broken, out of scope here",
  createdAt: CREATED_AT,
  intake: { drafterThreadId: DRAFTER_ID, acknowledgedAt: CREATED_AT },
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
        receipt: receipt({ intake: null }),
        drafterShell: null,
        nowMs: CREATED_AT_MS,
      }),
    ).toBe("dispatching");
  });

  it("stays dispatching however long intake takes", () => {
    // Long before the grace could matter: with no acknowledgement there is no
    // drafter yet, so absence of a shell says nothing about settlement.
    expect(
      deriveHandoffReceiptState({
        receipt: receipt({ intake: null }),
        drafterShell: null,
        nowMs: CREATED_AT_MS + 10 * HANDOFF_DRAFTER_APPEARANCE_GRACE_MS,
      }),
    ).toBe("dispatching");
  });

  it("is failed when intake itself rejected the handoff", () => {
    expect(
      deriveHandoffReceiptState({
        receipt: receipt({ intake: null, failure: "Source thread is busy." }),
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

  it("anchors the grace to acknowledgement, not submission, when intake is slow", () => {
    // The regression: a slow intake (longer than the whole grace) followed by a
    // just-created drafter that has not replayed yet. Measuring from submission
    // burns the window before the drafter could possibly appear, so the FIRST
    // render after acknowledgement reports a live drafter as settled — telling
    // the human a goal was staged while it may still fail.
    const slowIntakeMs = HANDOFF_DRAFTER_APPEARANCE_GRACE_MS * 2;
    const acknowledgedAt = new Date(CREATED_AT_MS + slowIntakeMs).toISOString();

    expect(
      deriveHandoffReceiptState({
        receipt: receipt({ intake: { drafterThreadId: DRAFTER_ID, acknowledgedAt } }),
        drafterShell: null,
        // Acknowledged this very instant; dispatch has already run for 10s.
        nowMs: CREATED_AT_MS + slowIntakeMs,
      }),
    ).toBe("drafting");

    // Still drafting just before the POST-ACK grace expires.
    expect(
      deriveHandoffReceiptState({
        receipt: receipt({ intake: { drafterThreadId: DRAFTER_ID, acknowledgedAt } }),
        drafterShell: null,
        nowMs: CREATED_AT_MS + slowIntakeMs + HANDOFF_DRAFTER_APPEARANCE_GRACE_MS - 1,
      }),
    ).toBe("drafting");

    // ...and only then does absence legitimately mean archived-hence-settled.
    expect(
      deriveHandoffReceiptState({
        receipt: receipt({ intake: { drafterThreadId: DRAFTER_ID, acknowledgedAt } }),
        drafterShell: null,
        nowMs: CREATED_AT_MS + slowIntakeMs + HANDOFF_DRAFTER_APPEARANCE_GRACE_MS + 1,
      }),
    ).toBe("settled");
  });

  it("never reports success from an unparseable acknowledgement timestamp", () => {
    expect(
      deriveHandoffReceiptState({
        receipt: receipt({
          intake: { drafterThreadId: DRAFTER_ID, acknowledgedAt: "not a timestamp" },
        }),
        drafterShell: null,
        nowMs: CREATED_AT_MS + 10 * HANDOFF_DRAFTER_APPEARANCE_GRACE_MS,
      }),
    ).toBe("drafting");
  });
});

describe("resolveHandoffReceiptShells", () => {
  const shell = (
    environmentId: string,
    id: string,
    overrides: Partial<HandoffThreadShell> = {},
  ): HandoffThreadShell => ({
    environmentId: environmentId as HandoffThreadShell["environmentId"],
    id: id as ThreadId,
    title: `${environmentId}/${id}`,
    archivedAt: null,
    attention: [],
    handoffDestinations: [],
    ...overrides,
  });
  const marker = (threadId: string, drafterThreadId: string | null) => ({
    goalId: "goal-1" as never,
    threadId: threadId as ThreadId,
    drafterThreadId: drafterThreadId as ThreadId | null,
  });

  it("reads the destinations off the SOURCE shell, attributed to this receipt's drafter", () => {
    // Two handoffs from one source: each receipt must see only its own, and the
    // drafter that placed them is already archived and out of the snapshot.
    const other = "drafter-2" as ThreadId;
    const resolved = resolveHandoffReceiptShells({
      receipts: [
        receipt(),
        receipt({
          id: "handoff_2",
          intake: { drafterThreadId: other, acknowledgedAt: CREATED_AT },
        }),
      ],
      shells: [
        shell("env", "thread-1", {
          handoffDestinations: [marker("dest-1", DRAFTER_ID), marker("dest-2", other)],
        }),
        shell("env", "dest-1", { title: "First staged goal" }),
      ],
    });

    expect(resolved.destinationsByReceiptId.get("handoff_1")).toEqual([
      { threadId: "dest-1", title: "First staged goal" },
    ]);
    // Staged but not (yet) in the snapshot: still linkable, just unlabelled.
    expect(resolved.destinationsByReceiptId.get("handoff_2")).toEqual([
      { threadId: "dest-2", title: null },
    ]);
  });

  it("never resolves across environments, which share thread ids by construction", () => {
    // `useThreadShells()` spans every connected environment, and two of them
    // backed by copies of one database legitimately carry the SAME thread ids.
    // Matching on the bare id would let whichever shell is walked last decide
    // the drafter's fate, the source's markers, and the destination's title.
    const resolved = resolveHandoffReceiptShells({
      receipts: [receipt()],
      shells: [
        shell("env", "thread-1", { handoffDestinations: [marker("dest-1", DRAFTER_ID)] }),
        shell("env", "dest-1", { title: "Right environment" }),
        shell("env", DRAFTER_ID, { archivedAt: "2026-01-01T00:00:20.000Z" }),
        // Same ids, different environment, contradicting every field.
        shell("other", "thread-1", { handoffDestinations: [marker("dest-9", DRAFTER_ID)] }),
        shell("other", "dest-1", { title: "Wrong environment" }),
        shell("other", DRAFTER_ID, { attention: ["needs_guidance"] }),
      ],
    });

    expect(resolved.destinationsByReceiptId.get("handoff_1")).toEqual([
      { threadId: "dest-1", title: "Right environment" },
    ]);
    expect(resolved.drafterShellsByReceiptId.get("handoff_1")?.attention).toEqual([]);
    expect(resolved.drafterShellsByReceiptId.get("handoff_1")?.archivedAt).toBe(
      "2026-01-01T00:00:20.000Z",
    );
  });

  it("resolves nothing for a receipt whose intake has not acknowledged yet", () => {
    const resolved = resolveHandoffReceiptShells({
      receipts: [receipt({ intake: null })],
      shells: [shell("env", "thread-1", { handoffDestinations: [marker("dest-1", DRAFTER_ID)] })],
    });

    expect(resolved.destinationsByReceiptId.size).toBe(0);
    expect(resolved.drafterShellsByReceiptId.size).toBe(0);
  });
});

describe("deriveHandoffReceiptViews", () => {
  it("shows the explanation verbatim and supplies a reason in the failed state", () => {
    const [view] = deriveHandoffReceiptViews({
      receipts: [receipt()],
      drafterShellsByReceiptId: new Map([
        ["handoff_1", drafterShell({ attention: ["needs_guidance"] })],
      ]),
      destinationsByReceiptId: new Map(),
      nowMs: CREATED_AT_MS + 30_000,
    });

    expect(view?.state).toBe("failed");
    expect(view?.explanation).toBe(receipt().explanation);
    expect(view?.failureReason).toContain("no goal was created");
  });

  it("prefers the dispatch error over the generic drafter reason", () => {
    const [view] = deriveHandoffReceiptViews({
      receipts: [receipt({ intake: null, failure: "Source thread is busy." })],
      drafterShellsByReceiptId: new Map(),
      destinationsByReceiptId: new Map(),
      nowMs: CREATED_AT_MS,
    });

    expect(view?.failureReason).toBe("Source thread is busy.");
  });

  it("carries no failure reason once settled", () => {
    const [view] = deriveHandoffReceiptViews({
      receipts: [receipt()],
      drafterShellsByReceiptId: new Map([
        ["handoff_1", drafterShell({ archivedAt: "2026-01-01T00:00:20.000Z" })],
      ]),
      destinationsByReceiptId: new Map(),
      nowMs: CREATED_AT_MS + 20_000,
    });

    expect(view?.state).toBe("settled");
    expect(view?.failureReason).toBeNull();
  });

  it("carries every destination the drafter staged, titled where the shell has one", () => {
    // The whole point of resolving destinations off the SOURCE shell: a drafter
    // may place several handoffs in one turn, and by the time the receipt
    // settles the drafter that placed them is archived and gone.
    const [view] = deriveHandoffReceiptViews({
      receipts: [receipt()],
      drafterShellsByReceiptId: new Map(),
      destinationsByReceiptId: new Map([
        [
          "handoff_1",
          [
            { threadId: "dest-1" as ThreadId, title: "Fix FooService retries" },
            { threadId: "dest-2" as ThreadId, title: null },
          ],
        ],
      ]),
      nowMs: CREATED_AT_MS + 30_000,
    });

    expect(view?.state).toBe("settled");
    expect(view?.destinations).toEqual([
      { threadId: "dest-1", title: "Fix FooService retries" },
      { threadId: "dest-2", title: null },
    ]);
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
    destinations: [],
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
    // The destinations ride along: away from the source thread the toast is the
    // only surface offering a way into what was just staged.
    const destinations = [{ threadId: "dest-1" as ThreadId, title: "Fix FooService retries" }];
    const pushes = deriveHandoffReceiptToastPushes({
      previousStates: previous("drafting"),
      views: [view({ destinations })],
      activeThreadKey: "env:thread-2",
    });

    expect(pushes).toEqual([
      expect.objectContaining({ receiptId: "handoff_1", kind: "success", destinations }),
    ]);
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
