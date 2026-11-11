/**
 * What this checkout's control plane sends for the things the human-in-child change altered
 * (plans/human-in-child-thread/plan.mdx §5, model-text §8): the held notice, a finished child's
 * submit result and the tools an engaged child gains. Revision 2's exports are looked up by name and
 * fall back to the build before them (arm V0); the fallbacks go once revision 2 lands.
 */
import * as Report from "../../apps/server/src/loom/workstream/report.ts";
import { ENGAGED_CHILD_TOOLS } from "../../apps/server/src/mcp/toolkits/workstream/families.ts";
import * as Render from "../../apps/server/src/mcp/toolkits/workstream/render.ts";
import { buildHeldHandbackMessage } from "../../apps/server/src/loom/orchestration/dispatcher/wakes.ts";

const exported = <T>(module: object, name: string): T | undefined =>
  (module as Record<string, unknown>)[name] as T | undefined;

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

const MARKERS = new Set(["<!-- response -->", "<!-- /response -->"]);
const linesOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !MARKERS.has(line));
/** Model-text §8.2's rule, until the server exports it as `repeatsReport` (arm V0 only). */
const repeatsReportV0 = (report: string, submission: string) => {
  const cut = report.indexOf("## Added after finishing · ");
  const original = linesOf(cut === -1 ? report : report.slice(0, cut));
  const submitted = new Set(linesOf(submission));
  return original.filter((line) => submitted.has(line)).length > original.length / 2;
};

/** Whether a finished child's submission repeats the report on file. */
export const repeatsReport =
  exported<(report: string, submission: string) => boolean>(Report, "repeatsReport") ??
  repeatsReportV0;

/**
 * The result of `workstream_submit` from a finished child a human has written to since it finished:
 * the addition echo, or, once the server refuses a repeat (`REPORT_REPEAT_REFUSAL`), that refusal.
 */
export const finishedSubmitResult = (
  report: string,
  markdown: string,
  reportPath: string,
): { readonly text: string; readonly isError: boolean } => {
  const refusal = exported<string>(Render, "REPORT_REPEAT_REFUSAL");
  return refusal !== undefined && repeatsReport(report, markdown)
    ? { text: refusal, isError: true }
    : { text: `${Render.REPORT_ADDITION_ECHO}\nReport: ${reportPath}`, isError: false };
};

/** Tools a child's session profile makes active once a person has written to it, beyond its role's. */
export const engagedChildTools = (): ReadonlyArray<string> => ENGAGED_CHILD_TOOLS;
