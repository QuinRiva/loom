/**
 * What this checkout's control plane sends, for the four things that differ between the base and
 * the human-in-child change (plans/human-in-child-thread/plan.mdx §5). Each looks for the export the
 * change adds and falls back to today's functions; the fallbacks are deleted in the change's third
 * commit. Everything else the eval shows a model is read from source directly in `cases.ts`.
 */
import { workSubmitRefusal } from "@t3tools/shared/workstreamGraph";
import type { ThreadId } from "@t3tools/contracts";

import * as Families from "../../apps/server/src/mcp/toolkits/workstream/families.ts";
import * as Render from "../../apps/server/src/mcp/toolkits/workstream/render.ts";
import * as Wakes from "../../apps/server/src/loom/orchestration/dispatcher/wakes.ts";
import { buildYieldWakeMessage } from "../../apps/server/src/loom/orchestration/dispatcher/yield.ts";

const exported = <T>(module: object, name: string): T | undefined =>
  (module as Record<string, unknown>)[name] as T | undefined;

export interface HeldChild {
  readonly id: string;
  readonly role: string;
  readonly title: string;
  readonly reportPath: string;
}

/** The outcome word a child made up for "finished, waiting for approval" on today's text. */
export const BASE_INVENTED_OUTCOME = "awaiting_human_approval";

/**
 * The notices a parent receives when a child hands finished work back held for the human.
 * Change (commit 1): one notice, `buildHeldHandbackMessage` in `wakes.ts` (model-text §5.1).
 * Base: the two-call pattern's two notices, the attention pause notice then the yield notice.
 */
export const heldHandbackNotices = (child: HeldChild, report: string): ReadonlyArray<string> => {
  const held = exported<(child: HeldChild, report: string | null) => string>(
    Wakes,
    "buildHeldHandbackMessage",
  );
  if (held) return [held(child, report)];
  const id = child.id as ThreadId;
  return [
    Wakes.buildChildWakeMessage(
      {
        id,
        role: child.role,
        lane: "in_progress",
        attention: ["awaiting_acceptance"],
        reportPath: child.reportPath,
      },
      "attention",
      report,
    ),
    buildYieldWakeMessage(
      { id, role: child.role, reportPath: child.reportPath },
      BASE_INVENTED_OUTCOME,
      report,
      undefined,
      { synthesised: false, gateSide: null, awaitingAcceptance: true },
    ),
  ];
};

/**
 * The result of `workstream_submit` from a finished child a human has written to since it finished.
 * Change (commit 2): accepted as an addition, `REPORT_ADDITION_ECHO` in `render.ts` (model-text
 * §4.3) followed by the report line. Base: refused as a terminal thread.
 */
export const finishedSubmitResult = (
  threadId: string,
  reportPath: string,
): { readonly text: string; readonly isError: boolean } => {
  const echo = exported<string>(Render, "REPORT_ADDITION_ECHO");
  if (echo !== undefined) return { text: `${echo}\nReport: ${reportPath}`, isError: false };
  return {
    text:
      workSubmitRefusal(
        {
          id: threadId as ThreadId,
          outcome: "done",
          pendingRework: false,
          routes: [],
        },
        "done",
        "terminal",
        false,
      ) ?? "",
    isError: true,
  };
};

/**
 * Tools a child's session profile makes active once a person has written to it, beyond its role's.
 * Change (commit 2): `ENGAGED_CHILD_TOOLS` in `families.ts` (`ask_user_question` and
 * `notify_thread`). Base: the human-input family alone.
 */
export const engagedChildTools = (): ReadonlyArray<string> =>
  exported<ReadonlyArray<string>>(Families, "ENGAGED_CHILD_TOOLS") ?? Families.HUMAN_INPUT;
