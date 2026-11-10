/**
 * loom: a document answer held in a thread's composer draft. The draft is the truth, as on web:
 * the answer exists while its chip is in the draft text, and removing the chip un-answers it.
 * The record arrives built by web's code in the document viewer; the app only stores it.
 */
import type { ComposerContextId, ReviewCommentContextRecord } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";

import {
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  setComposerDraftContext,
  setComposerDraftText,
} from "./use-composer-drafts";

const referenced = (text: string, contextId: ComposerContextId) =>
  collectComposerContextReferences(text).filter((ref) => ref.contextId === contextId);

/**
 * A re-answer replaces the record behind the chip already in the draft; a first answer joins
 * the end of the draft as a chip. False when the draft has no room for another context item.
 */
export function upsertComposerDraftContextRecord(
  draftKey: string,
  record: ReviewCommentContextRecord,
): boolean {
  const draft = getComposerDraftSnapshot(draftKey);
  if (referenced(draft.text, record.contextId).length === 0) {
    const end = draft.text.length;
    return insertComposerDraftContext(
      draftKey,
      { text: formatComposerContextReference(record), context: { version: 1, records: [record] } },
      { text: draft.text, start: end, end },
    );
  }
  const records = draft.context?.records ?? [];
  setComposerDraftContext(draftKey, {
    version: 1,
    records: records.some((entry) => entry.contextId === record.contextId)
      ? records.map((entry) => (entry.contextId === record.contextId ? record : entry))
      : [...records, record],
  });
  return true;
}

/** Cuts the chip (and the space it brought) from the text; the draft then drops its record. */
export function removeComposerDraftContextRecord(
  draftKey: string,
  contextId: ComposerContextId,
): void {
  let text = getComposerDraftSnapshot(draftKey).text;
  for (const { start, end } of referenced(text, contextId).reverse()) {
    const [from, to] =
      text[end] === " "
        ? [start, end + 1]
        : text[start - 1] === " "
          ? [start - 1, end]
          : [start, end];
    text = to >= text.length ? text.slice(0, from).trimEnd() : text.slice(0, from) + text.slice(to);
  }
  setComposerDraftText(draftKey, text);
}
