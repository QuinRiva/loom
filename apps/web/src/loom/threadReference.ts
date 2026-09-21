/**
 * loom: the draft-side payload behind a `#`-mentioned thread.
 *
 * A thread mention is an ordinary upstream context reference — the prompt
 * carries the canonical `t3-context://v1/thread/<contextId>` link and the send
 * carries a `thread` record — so this module only supplies the per-kind pieces
 * the generic machinery asks every kind for: an id, a reference, and the
 * record/draft conversions. `threadId` is the identity; `label` is the title at
 * mention time and is display-only.
 */
import { ThreadId, type ThreadContextRecord } from "@t3tools/contracts";
import { sanitizeComposerContextLabel } from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";

import {
  producerIdFromComposerContextId,
  toKindScopedComposerContextId,
  type ComposerContextReference,
} from "../lib/composerContextReferences";

export const ThreadReferenceDraftSchema = Schema.Struct({
  threadId: ThreadId,
  label: Schema.String,
});

export type ThreadReferenceDraft = typeof ThreadReferenceDraftSchema.Type;

export const isThreadReferenceDraft = Schema.is(ThreadReferenceDraftSchema);

export function threadReferenceContextId(threadId: ThreadId) {
  return toKindScopedComposerContextId("thread", threadId);
}

export function threadReferenceContextReference(
  draft: ThreadReferenceDraft,
): ComposerContextReference {
  return {
    kind: "thread",
    contextId: threadReferenceContextId(draft.threadId),
    label: sanitizeComposerContextLabel(draft.label, "thread"),
  };
}

export function threadContextRecord(draft: ThreadReferenceDraft): ThreadContextRecord {
  return {
    version: 1,
    contextId: threadReferenceContextId(draft.threadId),
    kind: "thread",
    label: sanitizeComposerContextLabel(draft.label, "thread"),
    threadId: draft.threadId,
  };
}

export function threadReferenceFromRecord(record: ThreadContextRecord): ThreadReferenceDraft {
  return {
    // The record's own threadId is the identity; the context id only namespaces it.
    threadId: record.threadId,
    label: record.label,
  };
}
