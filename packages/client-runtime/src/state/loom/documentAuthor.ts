import {
  DOCUMENT_QUERY_ROLE,
  type DocumentQueryAuthorResult,
  type ThreadId,
} from "@t3tools/contracts";

/** The author's thread and the document as it names it, where a review of the document belongs. */
export interface DocumentFollowTarget {
  readonly threadId: ThreadId;
  readonly filePath: string;
}

/**
 * loom: where a document opened in `viewingThreadId` should be reviewed: its author's thread, or
 * null to stay. Web and the phone both route a review by it
 * (plans/document-comments-to-author/plan.mdx §3, §5).
 */
export function documentFollowTarget(
  result: DocumentQueryAuthorResult,
  viewingThreadId: ThreadId,
  viewingRole: string | null,
): DocumentFollowTarget | null {
  return result.authorSource === "signature" &&
    result.authoringSignature &&
    result.authorThreadId !== viewingThreadId &&
    !result.authorArchived &&
    result.sameFile &&
    viewingRole !== DOCUMENT_QUERY_ROLE
    ? { threadId: result.authorThreadId, filePath: result.filePath }
    : null;
}
