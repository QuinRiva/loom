/**
 * The yield wake (V1 review-gates design §6), ported with logic unchanged: a
 * child whose submit routed to `yield` — an unmatched outcome, a gate's
 * exhausted round cap, or the quiescence rail's synthesised `quiescent` submit —
 * hands its turn to the parent. V1's `yielded` lane is the stored
 * `awaiting_orchestrator` attention; `mcp__t3-code__workstream_set_outcome` replaces
 * `set_lane`.
 *
 * @module loom/orchestration/dispatcher/yield
 */
import type { ControlPayload, ControlPayloadItem, ThreadId } from "@t3tools/contracts";

import { type DigestExtra, digestItems } from "./digest.ts";
import {
  formatReportExcerpt,
  reportItemFields,
  WORKSTREAM_CONTROL_PLANE_MARKER,
  type WakeMember,
} from "./wakes.ts";

interface YieldChild {
  readonly id: ThreadId;
  readonly role: string | null;
  readonly reportPath: string | null;
}

/** A cap-breach yield's gate context: both parties' latest reports and the round count. */
export interface YieldGateContext {
  readonly rounds: number;
  readonly maxRounds: number;
  readonly counterpart: {
    readonly id: ThreadId;
    readonly role: string | null;
    readonly reportPath: string | null;
    readonly report: string | null;
  } | null;
}

/**
 * `synthesised`: the quiescence rail's submit, not the agent's; `gateSide`: the child's side of
 * an unresolved gate (`rework` when a live reviewer's loop route names it, `reviewer` when it
 * holds the loop route, null outside a gate); `awaitingAcceptance`: the child still holds a
 * human's sign-off hold.
 */
export interface YieldFlags {
  readonly synthesised: boolean;
  readonly gateSide: "reviewer" | "rework" | null;
  readonly awaitingAcceptance?: boolean;
}

const reference = (reportPath: string | null) =>
  reportPath !== null
    ? `Report reference: \`${reportPath}\` (read the full report on demand).`
    : "_No report was filed._";

/**
 * Composes the yield wake text: the child yielded (turn over, NOT done,
 * dependents gated), why, its report reference with a bounded excerpt (and the
 * counterpart's on a cap breach), and the decision menu.
 */
export const buildYieldWakeMessage = (
  child: YieldChild,
  outcome: string,
  report: string | null,
  gate?: YieldGateContext,
  flags: YieldFlags = { synthesised: false, gateSide: null },
): string => {
  const who = child.role === null ? `\`${child.id}\`` : `${child.role} \`${child.id}\``;
  const parked =
    flags.gateSide !== null && gate === undefined
      ? " It is a member of an unresolved review gate, so the gate is parked until you act."
      : "";
  const held = flags.awaitingAcceptance
    ? " It also holds an `awaiting_acceptance` flag: a human's sign-off on its output is still pending, and either prompting it or setting it done clears that hold — do so only once you hold the human's approval; otherwise escalate to the human."
    : "";
  const lead =
    (flags.synthesised
      ? `Your Workstream sub-thread ${who} went quiet: it ended its turn without calling \`mcp__t3-code__workstream_submit\`, so the control plane synthesised a report from its last assistant message and yielded it to you. It carries \`awaiting_orchestrator\` — it has NOT finished and its dependents stay gated.${parked}`
      : gate
        ? `Your Workstream sub-thread ${who} YIELDED to you: it submitted \`${outcome}\` but its review gate's round cap is exhausted (${gate.rounds}/${gate.maxRounds} rework rounds used), so the control plane handed its turn to you instead of looping again. It carries \`awaiting_orchestrator\` — the gate is NOT resolved and dependents stay gated.`
        : `Your Workstream sub-thread ${who} YIELDED to you: it submitted its work with outcome \`${outcome}\`, which matched no route, so the control plane handed its turn to you instead of completing it. It carries \`awaiting_orchestrator\` — it has NOT finished and its dependents stay gated.${parked}`) +
    held;
  const counterpartSection =
    gate?.counterpart != null
      ? [
          "",
          `Gate counterpart ${gate.counterpart.role === null ? `\`${gate.counterpart.id}\`` : `${gate.counterpart.role} \`${gate.counterpart.id}\``} — latest round report:`,
          "",
          reference(gate.counterpart.reportPath) + formatReportExcerpt(gate.counterpart.report),
        ]
      : [];
  // The rework side of a gate completes only through the reviewer: setting it done would
  // bypass re-verification, so that option is withheld and the recovery rule given instead.
  const rework = flags.gateSide === "rework";
  const dissolves = gate !== undefined || flags.gateSide === "reviewer";
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    lead,
    "",
    reference(child.reportPath) + formatReportExcerpt(report),
    ...counterpartSection,
    "",
    ...(rework
      ? [
          "This child is the rework side of a review gate. If its work is done, prompt it to submit (`mcp__t3-code__workstream_prompt`) so the reviewer re-verifies, rather than marking it done; to end the gate instead, mark the reviewer done, not this child. After resuming it, the reviewer runs again on its submit.",
          "",
        ]
      : []),
    "The decision is yours: resume it with guidance (`mcp__t3-code__workstream_prompt` — your prompt clears `awaiting_orchestrator` when its turn starts), " +
      (rework
        ? ""
        : "accept its work as-is (`mcp__t3-code__workstream_set_outcome` done, which releases dependents" +
          (dissolves ? " and dissolves the gate" : "") +
          "), ") +
      "re-plan around it (spawn a replacement and `mcp__t3-code__workstream_set_outcome` cancelled on it), or escalate to the human." +
      (gate
        ? " Adjudicate the open findings yourself before choosing: they are claims, not verdicts — judge each by what concretely fails without it and what recovery costs at this project's posture, and accept over the reviewer's objection where that bar isn't met."
        : ""),
  ].join("\n");
};

/**
 * The yield wake's `controlPayload`: the yielding child, the gate counterpart
 * (if any), then any piggybacked digest's items, so the card represents
 * everything the sent text carries. `synthesised` marks a quiescent yield.
 */
export const buildYieldPayload = (
  child: YieldChild,
  outcome: string,
  report: string | null,
  gate?: YieldGateContext,
  piggyback?: {
    readonly members: ReadonlyArray<WakeMember>;
    readonly extras: ReadonlyArray<DigestExtra>;
  },
  flags: YieldFlags = { synthesised: false, gateSide: null },
): ControlPayload => {
  const items: ControlPayloadItem[] = [
    {
      threadId: child.id,
      ...(child.role !== null ? { role: child.role } : {}),
      title: flags.synthesised
        ? "Went quiet — report synthesised"
        : `Yielded to you — outcome \`${outcome}\``,
      status: "yielded",
      icon: "↩️",
      ...reportItemFields(child.reportPath, report),
    },
  ];
  const counterpart = gate?.counterpart ?? null;
  if (counterpart !== null) {
    items.push({
      threadId: counterpart.id,
      ...(counterpart.role !== null ? { role: counterpart.role } : {}),
      title: "Gate counterpart — latest round report",
      status: "counterpart",
      icon: "🔁",
      ...reportItemFields(counterpart.reportPath, counterpart.report),
    });
  }
  if (piggyback !== undefined) items.push(...digestItems(piggyback.members, piggyback.extras));
  return {
    kind: "yield",
    ...(flags.synthesised ? { synthesised: true } : {}),
    heading: flags.synthesised
      ? `A sub-thread went quiet; its report was synthesised${flags.gateSide !== null ? " (gate parked)" : ""}.`
      : gate
        ? `A sub-thread yielded to you (review-gate round cap exhausted, ${gate.rounds}/${gate.maxRounds}).`
        : `A sub-thread yielded to you (unmatched outcome${flags.gateSide !== null ? "; gate parked" : ""}).`,
    items,
  };
};
