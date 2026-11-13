/**
 * loom: the line under a signed document's header naming where its comments go: the thread that
 * wrote it, any thread that changed it since, and a Review there button when the document should
 * be reviewed with its author (plans/document-comments-to-author/plan.mdx §3). Derived from the
 * cached author lookup on each render; holds no state.
 */
import type { DocumentQueryAuthorResult, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { MarkdownThreadLink } from "../components/chat/MarkdownThreadLink";
import { Button } from "../components/ui/button";
import { environmentThreadShells } from "../state/threads";
import { useDocumentQueryAuthor } from "./documentQueryPins";
import { documentFollowTarget, useMoveDocumentToAuthor } from "./openDocumentLink";

export function LoomMdxAuthorLine(props: {
  readonly filePath: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const author = useDocumentQueryAuthor(props.threadRef, props.filePath);
  const role =
    useAtomValue(environmentThreadShells.threadShellAtom(props.threadRef))?.source.workstream
      ?.role ?? null;
  const move = useMoveDocumentToAuthor();
  if (author === null) return null;
  const target = documentFollowTarget(author, props.threadRef.threadId, role);
  return (
    <LoomMdxAuthorLineView
      author={author}
      threadRef={props.threadRef}
      onReviewThere={target && (() => move(props.threadRef, props.filePath, target))}
    />
  );
}

/** The rendered line, from a resolved lookup (the preview harness renders it directly). */
export function LoomMdxAuthorLineView({
  author,
  threadRef,
  onReviewThere,
}: {
  readonly author: DocumentQueryAuthorResult;
  readonly threadRef: ScopedThreadRef;
  readonly onReviewThere: (() => void) | null;
}) {
  const chip = (threadId: DocumentQueryAuthorResult["authorThreadId"], title: string) => (
    <MarkdownThreadLink
      key={threadId}
      environmentId={threadRef.environmentId}
      link={{ environmentId: threadRef.environmentId, threadId }}
      label={title}
      fromThreadRef={threadRef}
    />
  );
  const signed = author.authorSource === "signature" && author.authoringSignature;
  const here = signed && author.authorThreadId === threadRef.threadId;
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b px-3 py-1.5 text-2xs text-muted-foreground"
      data-mdx-author-line
    >
      {here ? (
        <span>Written by this thread</span>
      ) : signed ? (
        <>
          <span>Written by</span>
          {chip(author.authorThreadId, author.authorTitle)}
          {author.authorArchived ? <span>(archived)</span> : null}
          {author.sameFile ? null : <span>in another worktree</span>}
          <span>· Comments here go to this thread</span>
        </>
      ) : (
        <span>Comments go to this thread</span>
      )}
      {author.laterEditors.length > 0 ? (
        <>
          <span>· Changed since by</span>
          {author.laterEditors.map((editor) => chip(editor.threadId, editor.title))}
        </>
      ) : null}
      {onReviewThere ? (
        <Button variant="outline" size="micro" className="ms-auto" onClick={onReviewThere}>
          Review there
        </Button>
      ) : null}
    </div>
  );
}
