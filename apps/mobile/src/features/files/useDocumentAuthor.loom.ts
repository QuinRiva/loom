/**
 * loom: which thread's draft a document's tapped answers join: its author's when the author
 * lookup says the document is reviewed there (plans/document-comments-to-author/plan.mdx §5),
 * otherwise the thread it was opened in, including when the lookup fails. Null until the lookup
 * settles, so no answer is taken before the draft it belongs in is known.
 */
import { documentFollowTarget } from "@t3tools/client-runtime/state/loom/documentAuthor";
import { createLoomCommandAtoms } from "@t3tools/client-runtime/state/loom/goalCommands";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";

const loomCommands = createLoomCommandAtoms(connectionAtomRuntime);

export interface DocumentAnswersTarget {
  readonly threadId: ThreadId;
  /** The document as that thread names it, so an answer's record matches web's there. */
  readonly filePath: string;
  /** The author's title when answers go to the author; null for the thread it was opened in. */
  readonly authorTitle: string | null;
}

export function useDocumentAnswersTarget(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  filePath: string,
): DocumentAnswersTarget | null {
  const key = threadId === null ? null : JSON.stringify([environmentId, threadId, filePath]);
  const [settled, setSettled] = useState<{
    readonly key: string;
    readonly target: DocumentAnswersTarget;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server who wrote the document, once per document opened
  useEffect(() => {
    if (key === null || threadId === null) return;
    let live = true;
    void executeAtomQuery(
      appAtomRegistry,
      loomCommands.documentQueryAuthor({
        environmentId,
        input: { sourceThreadId: threadId, filePath },
      }),
      { reportFailure: false, reportDefect: false },
    ).then((result) => {
      if (!live) return;
      const role =
        appAtomRegistry.get(environmentThreadShells.threadShellAtom({ environmentId, threadId }))
          ?.source.workstream?.role ?? null;
      const author =
        result._tag === "Success" ? documentFollowTarget(result.value, threadId, role) : null;
      setSettled({
        key,
        target:
          author && result._tag === "Success"
            ? { ...author, authorTitle: result.value.authorTitle }
            : { threadId, filePath, authorTitle: null },
      });
    });
    return () => {
      live = false;
    };
  }, [environmentId, threadId, filePath, key]);
  return settled?.key === key ? settled.target : null;
}
