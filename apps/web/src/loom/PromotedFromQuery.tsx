/**
 * loom: the link back on a review comment promoted from a query thread
 * (plans/plan-query-threads/plan.mdx §2.5), shown in the chip's details in the author's
 * composer and in its sent message: "Promoted from Query: plan.mdx", the query thread's mention.
 */
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { MarkdownThreadLink } from "../components/chat/MarkdownThreadLink";

export function PromotedFromQuery(props: {
  readonly environmentId: EnvironmentId | null;
  readonly queryThreadId: ThreadId;
  readonly filePath: string;
  readonly fromThreadRef?: ScopedThreadRef | undefined;
}) {
  if (props.environmentId === null) return null;
  return (
    <div className="text-2xs text-muted-foreground" data-promoted-from-query="">
      Promoted from{" "}
      <MarkdownThreadLink
        environmentId={props.environmentId}
        threadId={props.queryThreadId}
        label={`Query: ${props.filePath.split("/").pop() ?? props.filePath}`}
        fromThreadRef={props.fromThreadRef}
      />
    </div>
  );
}
