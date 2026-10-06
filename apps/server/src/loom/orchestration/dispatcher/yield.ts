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
  boundedExcerpt,
  formatReportExcerpt,
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

/** `synthesised`: the quiescence rail's submit, not the agent's; `gateParked`: the child is an unresolved gate member. */
export interface YieldFlags {
  readonly synthesised: boolean;
  readonly gateParked: boolean;
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
  flags: YieldFlags = { synthesised: false, gateParked: false },
): string => {
  const who = child.role === null ? `\`${child.id}\`` : `${child.role} \`${child.id}\``;
  const parked =
    flags.gateParked && gate === undefined
      ? " It is a member of an unresolved review gate, so the gate is parked until you act."
      : "";
  const lead = flags.synthesised
    ? `Your Workstream sub-thread ${who} went quiet: it ended its turn without calling \`mcp__t3-code__workstream_submit\`, so the control plane synthesised a report from its last assistant message and yielded it to you. It carries \`awaiting_orchestrator\` — it has NOT finished and its dependents stay gated.${parked}`
    : gate
      ? `Your Workstream sub-thread ${who} YIELDED to you: it submitted \`${outcome}\` but its review gate's round cap is exhausted (${gate.rounds}/${gate.maxRounds} rework rounds used), so the control plane handed its turn to you instead of looping again. It carries \`awaiting_orchestrator\` — the gate is NOT resolved and dependents stay gated.`
      : `Your Workstream sub-thread ${who} YIELDED to you: it submitted its work with outcome \`${outcome}\`, which matched no route, so the control plane handed its turn to you instead of completing it. It carries \`awaiting_orchestrator\` — it has NOT finished and its dependents stay gated.${parked}`;
  const counterpartSection =
    gate?.counterpart != null
      ? [
          "",
          `Gate counterpart ${gate.counterpart.role === null ? `\`${gate.counterpart.id}\`` : `${gate.counterpart.role} \`${gate.counterpart.id}\``} — latest round report:`,
          "",
          reference(gate.counterpart.reportPath) + formatReportExcerpt(gate.counterpart.report),
        ]
      : [];
  const dissolves = gate !== undefined || flags.gateParked;
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    lead,
    "",
    reference(child.reportPath) + formatReportExcerpt(report),
    ...counterpartSection,
    "",
    "The decision is yours: resume it with guidance (`mcp__t3-code__workstream_prompt` — your prompt clears `awaiting_orchestrator` when its turn starts), accept its work as-is (`mcp__t3-code__workstream_set_outcome` done, which releases dependents" +
      (dissolves ? " and dissolves the gate" : "") +
      "), re-plan around it (spawn a replacement and `mcp__t3-code__workstream_set_outcome` cancelled on it), or escalate to the human." +
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
  flags: YieldFlags = { synthesised: false, gateParked: false },
): ControlPayload => {
  const excerpt = boundedExcerpt(report);
  const items: ControlPayloadItem[] = [
    {
      threadId: child.id,
      ...(child.role !== null ? { role: child.role } : {}),
      title: flags.synthesised
        ? "Went quiet — report synthesised"
        : `Yielded to you — outcome \`${outcome}\``,
      status: "yielded",
      icon: "↩️",
      ...(child.reportPath !== null ? { reportPath: child.reportPath } : {}),
      ...(excerpt !== undefined ? { excerpt } : {}),
    },
  ];
  const counterpart = gate?.counterpart ?? null;
  if (counterpart !== null) {
    const counterpartExcerpt = boundedExcerpt(counterpart.report);
    items.push({
      threadId: counterpart.id,
      ...(counterpart.role !== null ? { role: counterpart.role } : {}),
      title: "Gate counterpart — latest round report",
      status: "counterpart",
      icon: "🔁",
      ...(counterpart.reportPath !== null ? { reportPath: counterpart.reportPath } : {}),
      ...(counterpartExcerpt !== undefined ? { excerpt: counterpartExcerpt } : {}),
    });
  }
  if (piggyback !== undefined) items.push(...digestItems(piggyback.members, piggyback.extras));
  return {
    kind: "yield",
    ...(flags.synthesised ? { synthesised: true } : {}),
    heading: flags.synthesised
      ? `A sub-thread went quiet; its report was synthesised${flags.gateParked ? " (gate parked)" : ""}.`
      : gate
        ? `A sub-thread yielded to you (review-gate round cap exhausted, ${gate.rounds}/${gate.maxRounds}).`
        : `A sub-thread yielded to you (unmatched outcome${flags.gateParked ? "; gate parked" : ""}).`,
    items,
  };
};
