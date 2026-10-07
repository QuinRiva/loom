/**
 * The review gate's leg messages (V1 review-gates design §4.3), ported with
 * logic unchanged: the rework resume to the loop target and the re-verify
 * resume to the reviewer. `makeGateLegComposer` is the `GateLegComposer` the
 * dispatcher hands `runReDrivePass`; the arm nests the result inside
 * `thread.gate.rework` / `thread.gate.reverify` (never dispatched bare).
 *
 * @module loom/orchestration/dispatcher/gateLegs
 */
import type { ThreadId } from "@t3tools/contracts";

import type { GateLegComposer } from "../redrive.ts";
import { boundedExcerpt, formatReportExcerpt, WORKSTREAM_CONTROL_PLANE_MARKER } from "./wakes.ts";

interface GateParty {
  readonly id: ThreadId;
  readonly role: string | null;
  readonly reportPath: string | null;
}

/**
 * The rework resume delivered to the loop target when the reviewer routes
 * findings back: the round, the findings reference and excerpt, the
 * adjudication protocol, and that its next submit routes back to the reviewer.
 */
export const buildGateReworkMessage = (
  reviewer: GateParty,
  round: number,
  report: string | null,
): string =>
  [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    `Review round ${round}: the ${reviewer.role ?? "reviewer"} \`${reviewer.id}\` returned findings on your work — your review gate looped it back to you for rework.`,
    "",
    (reviewer.reportPath !== null
      ? `Report reference: \`${reviewer.reportPath}\` (read the full findings on demand).`
      : "_No report file was found for the findings._") + formatReportExcerpt(report),
    "",
    "Reviewer findings are claims, not verdicts: adjudicate each one — implement what survives scrutiny, reject the rest WITH REASONS in your round report (rejecting without reasons and implementing without evaluating are both failures). Scrutiny means asking: what concretely fails if I don't act, and what does recovery cost? Accurate evidence of what the code does is not validation of the reviewer's prescribed fix — reaching `clean` is not the goal; the right change is. If the same finding comes back contested a second time, stop looping on it and say so in your report; the reviewer escalates it.",
    "",
    "When you finish, end with one `mcp__t3-code__workstream_submit` as usual. Routing notice: your next submit routes back to the reviewer for re-verification, NOT to done — write it as a round report (per finding: what you did, or why you rejected it).",
  ].join("\n");

/**
 * The re-verify resume delivered to the reviewer when the loop target routes
 * its rework back: delta-review discipline and how each verdict routes.
 */
export const buildGateReverifyMessage = (
  coder: GateParty,
  round: number,
  report: string | null,
): string =>
  [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    `Review round ${round}: the ${coder.role ?? "coder"} \`${coder.id}\` returned its rework — your review gate routed it to you for re-verification.`,
    "",
    (coder.reportPath !== null
      ? `Report reference: \`${coder.reportPath}\` (read the full round report on demand).`
      : "_No report file was found for the rework._") + formatReportExcerpt(report),
    "",
    "This is a DELTA review: scope to the changes plus your previously flagged items — raising brand-new findings on unchanged code in a rework round is a review failure unless the rework itself exposed them. Where the coder rejected a finding with reasons, adjudicate: contest it at most once; a twice-contested finding is escalated, never re-looped.",
    "",
    "Submit your verdict with `mcp__t3-code__workstream_submit`: `clean` or `fixed_inline` resolves the gate (both threads complete), `needs_rework` loops again while rounds remain (then yields you to the orchestrator), any other outcome yields you to the orchestrator.",
  ].join("\n");

/**
 * The dispatcher's gate-leg composer: `reports` maps a report path to its
 * contents (read once per pass), so the composer stays pure.
 */
export const makeGateLegComposer =
  (reports: ReadonlyMap<string, string | null>): GateLegComposer =>
  (leg) => {
    const party = {
      id: leg.source.threadId,
      role: leg.source.role,
      reportPath: leg.source.reportPath,
    };
    const report = party.reportPath === null ? null : (reports.get(party.reportPath) ?? null);
    const rework = leg.kind === "rework";
    const heading = rework ? "Review gate: rework requested" : "Review gate: re-verify";
    const excerpt = boundedExcerpt(report);
    return {
      text: (rework ? buildGateReworkMessage : buildGateReverifyMessage)(party, leg.round, report),
      controlPayload: {
        kind: "notice",
        notice: rework ? "gate-rework" : "gate-reverify",
        heading: `${heading} (round ${leg.round})`,
        items: [
          {
            threadId: party.id,
            ...(party.role !== null ? { role: party.role } : {}),
            title: rework ? `Findings — round ${leg.round}` : `Rework — round ${leg.round}`,
            ...(party.reportPath !== null ? { reportPath: party.reportPath } : {}),
            ...(excerpt !== undefined ? { excerpt } : {}),
          },
        ],
      },
    };
  };
