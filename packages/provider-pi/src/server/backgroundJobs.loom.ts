/**
 * The `loom-jobs` status line Loom's pi extension sends: the running job count and, just before a
 * job's wake message, the chip summary for its turn. The adapter pins the session while
 * `running > 0` and labels the next unprompted run `wake`.
 *
 * @module provider-pi/server/backgroundJobs.loom
 */
export const LOOM_JOBS_STATUS_KEY = "loom-jobs";

export interface LoomJobsStatus {
  readonly running: number;
  readonly wake: { readonly summary: string; readonly outcome: "completed" | "failed" } | null;
}

export const NO_LOOM_JOBS: LoomJobsStatus = { running: 0, wake: null };

/** Anything missing or malformed clears to no jobs: the worst case is no pin, today's behaviour. */
export const parseLoomJobsStatus = (statusText: string | undefined): LoomJobsStatus => {
  try {
    const parsed: unknown = JSON.parse(statusText ?? "");
    if (typeof parsed !== "object" || parsed === null) return NO_LOOM_JOBS;
    const { running, wake } = parsed as { running?: unknown; wake?: unknown };
    const summary = (wake as { summary?: unknown } | undefined)?.summary;
    const outcome = (wake as { outcome?: unknown } | undefined)?.outcome;
    return {
      running: typeof running === "number" && running > 0 ? running : 0,
      wake:
        typeof summary === "string" &&
        summary.trim() !== "" &&
        (outcome === "completed" || outcome === "failed")
          ? { summary: summary.trim(), outcome }
          : null,
    };
  } catch {
    return NO_LOOM_JOBS;
  }
};
