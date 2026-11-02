/**
 * The review gate's leg messages, ported from V1: the rework resume to the loop target and the
 * re-verify resume to the reviewer. The arm nests the result inside `thread.gate.rework` /
 * `thread.gate.reverify`; it is never dispatched bare.
 */
import type { LoomThreadWorkstream, ThreadId } from "@t3tools/contracts";

import type { GateLegComposer } from "../redrive.ts";
import { formatReportExcerpt, reportItemFields, WORKSTREAM_CONTROL_PLANE_MARKER } from "./wakes.ts";

interface GateParty {
  readonly id: ThreadId;
  readonly role: string | null;
  readonly reportPath: string | null;
}

/**
 * The rework resume delivered to a loop target when the reviewer routes
 * findings back: the round, the findings reference and excerpt, the siblings
 * reopened alongside it, the adjudication protocol, and that its next submit
 * routes back to the reviewer.
 */
export const buildGateReworkMessage = (
  reviewer: GateParty,
  round: number,
  report: string | null,
  alongside: ReadonlyArray<ThreadId> = [],
): string =>
  [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    `Review round ${round}: the ${reviewer.role ?? "reviewer"} \`${reviewer.id}\` returned findings on your work: your review gate looped it back to you for rework.`,
    ...(alongside.length > 0
      ? [
          "",
          `The same verdict reopened ${alongside.map((id) => `\`${id}\``).join(", ")}; ${alongside.length === 1 ? "it reworks" : "they rework"} in this worktree alongside you.`,
        ]
      : []),
    "",
    (reviewer.reportPath !== null
      ? `Report reference: \`${reviewer.reportPath}\` (read the full findings on demand).`
      : "_No report file was found for the findings._") + formatReportExcerpt(report),
    "",
    "Reviewer findings are claims, not verdicts: adjudicate each one: implement what survives scrutiny, reject the rest WITH REASONS in your round report (rejecting without reasons and implementing without evaluating are both failures). Scrutiny means asking: what concretely fails if I don't act, and what does recovery cost? Accurate evidence of what the code does is not validation of the reviewer's prescribed fix; reaching `clean` is not the goal; the right change is. If the same finding comes back contested a second time, stop looping on it and say so in your report; the reviewer escalates it.",
    "",
    "When you finish, end with one `mcp__t3-code__workstream_submit` as usual. Routing notice: your next submit routes back to the reviewer for re-verification, NOT to done. Write it as a round report (per finding: what you did, or why you rejected it).",
  ].join("\n");

/**
 * The re-verify resume delivered to the reviewer once every sibling reopened this round has
 * routed its rework back: one reference and excerpt per sibling, delta-review discipline and how
 * each verdict routes.
 */
export const buildGateReverifyMessage = (
  coders: ReadonlyArray<GateParty>,
  round: number,
  reports: ReadonlyArray<string | null>,
): string => {
  const reference = (coder: GateParty, index: number) =>
    (coder.reportPath !== null
      ? `Report reference: \`${coder.reportPath}\` (read the full round report on demand).`
      : "_No report file was found for the rework._") + formatReportExcerpt(reports[index] ?? null);
  const [only] = coders;
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    ...(coders.length === 1 && only !== undefined
      ? [
          `Review round ${round}: the ${only.role ?? "coder"} \`${only.id}\` returned its rework: your review gate routed it to you for re-verification.`,
          "",
          reference(only, 0),
        ]
      : [
          `Review round ${round}: ${coders.length} siblings returned their rework: your review gate routed them to you for re-verification.`,
          ...coders.flatMap((coder, index) => [
            "",
            `### ${coder.role ?? "coder"} \`${coder.id}\``,
            "",
            reference(coder, index),
          ]),
        ]),
    "",
    "This is a DELTA review: scope to the changes plus your previously flagged items; raising brand-new findings on unchanged code in a rework round is a review failure unless the rework itself exposed them. Where the coder rejected a finding with reasons, adjudicate: contest it at most once; a twice-contested finding is escalated, never re-looped.",
    "",
    coders.length === 1
      ? "Submit your verdict with `mcp__t3-code__workstream_submit`: `clean` or `fixed_inline` resolves the gate (both threads complete), `needs_rework` loops again while rounds remain (then yields you to the orchestrator), any other outcome yields you to the orchestrator."
      : "Submit your verdict with `mcp__t3-code__workstream_submit`: `clean` or `fixed_inline` resolves the gate (you and every sibling complete), `needs_rework` naming in `rework` the siblings to send back loops again while rounds remain (then yields you to the orchestrator), any other outcome yields you to the orchestrator.",
  ].join("\n");
};

/**
 * The dispatcher's gate-leg composer: `reports` maps a report path to its
 * contents (read once per pass), so the composer stays pure.
 */
export const makeGateLegComposer =
  (reports: ReadonlyMap<string, string | null>): GateLegComposer =>
  (leg) => {
    const partyOf = (row: LoomThreadWorkstream) => ({
      id: row.threadId,
      role: row.role,
      reportPath: row.reportPath,
    });
    const reportOf = (party: GateParty) =>
      party.reportPath === null ? null : (reports.get(party.reportPath) ?? null);
    const itemOf = (party: GateParty, title: string) => ({
      threadId: party.id,
      ...(party.role !== null ? { role: party.role } : {}),
      title,
      ...reportItemFields(party.reportPath, reportOf(party)),
    });
    if (leg.kind === "rework") {
      const reviewer = partyOf(leg.source);
      const alongside = leg.source.lastRoutes
        .filter(
          (route) =>
            route.kind === "loop" && route.round === leg.round && route.to !== leg.targetThreadId,
        )
        .map((route) => route.to);
      return {
        text: buildGateReworkMessage(reviewer, leg.round, reportOf(reviewer), alongside),
        controlPayload: {
          kind: "notice",
          notice: "gate-rework",
          heading: `Review gate: rework requested (round ${leg.round})`,
          items: [itemOf(reviewer, `Findings (round ${leg.round})`)],
        },
      };
    }
    const coders = leg.sources.map(partyOf);
    return {
      text: buildGateReverifyMessage(coders, leg.round, coders.map(reportOf)),
      controlPayload: {
        kind: "notice",
        notice: "gate-reverify",
        heading: `Review gate: re-verify (round ${leg.round})`,
        items: coders.map((coder) => itemOf(coder, `Rework (round ${leg.round})`)),
      },
    };
  };
