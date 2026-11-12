/**
 * What this checkout's control plane sends for the things the human-in-child change altered
 * (plans/human-in-child-thread/plan.mdx §5, model-text §8): the held notice, a finished child's
 * submit result and the tools an engaged child gains.
 */
import { buildHeldHandbackMessage } from "../../apps/server/src/loom/orchestration/dispatcher/wakes.ts";
import { repeatsReport } from "../../apps/server/src/loom/workstream/report.ts";
import { ENGAGED_CHILD_TOOLS } from "../../apps/server/src/mcp/toolkits/workstream/families.ts";
import {
  REPORT_ADDITION_ECHO,
  REPORT_REPEAT_REFUSAL,
} from "../../apps/server/src/mcp/toolkits/workstream/render.ts";

export { repeatsReport };

export interface HeldChild {
  readonly id: string;
  readonly role: string;
  readonly title: string;
  readonly reportPath: string;
}

/** The one notice a parent receives when a child hands finished work back held for the human. */
export const heldHandbackNotices = (child: HeldChild, report: string): ReadonlyArray<string> => [
  buildHeldHandbackMessage(child, report),
];

/** A finished child's submit after a human wrote: refused when it repeats the report, else added. */
export const finishedSubmitResult = (
  report: string,
  markdown: string,
  reportPath: string,
): { readonly text: string; readonly isError: boolean } =>
  repeatsReport(report, markdown)
    ? { text: REPORT_REPEAT_REFUSAL, isError: true }
    : { text: `${REPORT_ADDITION_ECHO}\nReport: ${reportPath}`, isError: false };

/** Tools a child's session profile makes active once a person has written to it, beyond its role's. */
export const engagedChildTools = (): ReadonlyArray<string> => ENGAGED_CHILD_TOOLS;
