import { describe, expect, it } from "vite-plus/test";

import { decideIngestionLiveness } from "./ProviderRuntimeIngestionTelemetry.ts";

const PREVIOUS_CHECK_AT_MS = 1_000_000;
const check = (input: {
  progressSincePreviousCheck: boolean;
  queueDepth?: number;
  blockedSinceMs?: number;
  stalledChecks?: number;
}) => ({
  previousCheckAtMs: PREVIOUS_CHECK_AT_MS,
  lastProgressAtMs: PREVIOUS_CHECK_AT_MS + (input.progressSincePreviousCheck ? 1 : -1),
  queueDepth: input.queueDepth ?? 0,
  blockedSinceMs: input.blockedSinceMs ?? Number.POSITIVE_INFINITY,
  stalledChecks: input.stalledChecks ?? 0,
});

describe("decideIngestionLiveness", () => {
  it("stays ok while idle, however long since the last event", () => {
    expect(decideIngestionLiveness(check({ progressSincePreviousCheck: false }))).toEqual({
      liveness: "ok",
      stalledChecks: 0,
    });
  });

  it("warns on a stalled check and escalates after the threshold in a row", () => {
    const stalled = (stalledChecks: number) =>
      decideIngestionLiveness(
        check({ progressSincePreviousCheck: false, queueDepth: 3, stalledChecks }),
      );
    expect(stalled(0)).toEqual({ liveness: "warn", stalledChecks: 1 });
    expect(stalled(3)).toEqual({ liveness: "warn", stalledChecks: 4 });
    expect(stalled(4)).toEqual({ liveness: "escalate", stalledChecks: 5 });
  });

  it("resets as soon as an item starts or finishes", () => {
    expect(
      decideIngestionLiveness(
        check({ progressSincePreviousCheck: true, queueDepth: 3, stalledChecks: 4 }),
      ),
    ).toEqual({ liveness: "ok", stalledChecks: 0 });
  });

  // `blockedSinceMs` is the earliest of a suspended publish and a paused pi
  // stdout. The stdout case is a wedge upstream of `publish` (the adapter fibre
  // stuck in SQL): the ingestion queue stays empty and only the pause shows it.
  it("counts the pipeline blocked since before the previous check as pending work", () => {
    expect(
      decideIngestionLiveness(
        check({
          progressSincePreviousCheck: false,
          blockedSinceMs: PREVIOUS_CHECK_AT_MS - 1,
          stalledChecks: 4,
        }),
      ).liveness,
    ).toBe("escalate");
    // Blocked only since the previous check: not yet a whole stalled interval.
    expect(
      decideIngestionLiveness(
        check({
          progressSincePreviousCheck: false,
          blockedSinceMs: PREVIOUS_CHECK_AT_MS + 1,
        }),
      ).liveness,
    ).toBe("ok");
    // Blocked, but ingestion made progress: slow, not wedged.
    expect(
      decideIngestionLiveness(
        check({
          progressSincePreviousCheck: true,
          blockedSinceMs: PREVIOUS_CHECK_AT_MS - 1,
          stalledChecks: 4,
        }),
      ).liveness,
    ).toBe("ok");
  });

  it("takes the threshold as a parameter", () => {
    expect(
      decideIngestionLiveness(check({ progressSincePreviousCheck: false, queueDepth: 1 }), 1)
        .liveness,
    ).toBe("escalate");
  });
});
