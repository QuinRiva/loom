/**
 * What this checkout's control plane sends for the things the human-in-child change altered
 * (plans/human-in-child-thread/plan.mdx §5): the held notice, a finished child's addition and the
 * tools an engaged child gains. Everything else the eval shows a model is read from source in `cases.ts`.
 */
import { ENGAGED_CHILD_TOOLS } from "../../apps/server/src/mcp/toolkits/workstream/families.ts";
import { REPORT_ADDITION_ECHO } from "../../apps/server/src/mcp/toolkits/workstream/render.ts";
import { buildHeldHandbackMessage } from "../../apps/server/src/loom/orchestration/dispatcher/wakes.ts";

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

/** The result of `workstream_submit` from a finished child a human has written to since it finished. */
export const finishedSubmitResult = (
  reportPath: string,
): { readonly text: string; readonly isError: boolean } => ({
  text: `${REPORT_ADDITION_ECHO}\nReport: ${reportPath}`,
  isError: false,
});

/** Tools a child's session profile makes active once a person has written to it, beyond its role's. */
export const engagedChildTools = (): ReadonlyArray<string> => ENGAGED_CHILD_TOOLS;
