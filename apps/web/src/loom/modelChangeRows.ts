/**
 * loom: the "Model: A → B" divider — one row before the user message that
 * starts a run whose model differs from the previous run's on the same
 * provider instance. Covers a composer model switch and the reroute sweep's
 * fallback / move-back alike (both start runs with a new selection). An
 * instance change is upstream's context-handoff row, and a thinking-level
 * (`modelSelection.options`) change is deliberately not a row.
 */
import type { OrchestrationV2Run, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";

export type ModelChangeRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection" | "userMessageId" | "requestedAt"
>;

export interface LoomModelChangeRow {
  readonly kind: "loom-model-change";
  readonly id: string;
  readonly createdAt: string;
  /** The run's user message; the row renders immediately before it. */
  readonly messageId: string;
  readonly instanceId: ProviderInstanceId;
  readonly fromModel: string;
  readonly toModel: string;
}

export function modelChangeRows(
  runs: ReadonlyArray<ModelChangeRun>,
): ReadonlyArray<LoomModelChangeRow> {
  const ordered = runs.toSorted((left, right) => left.ordinal - right.ordinal);
  return ordered.flatMap((run, index) => {
    const previous = ordered[index - 1];
    return previous === undefined ||
      previous.providerInstanceId !== run.providerInstanceId ||
      previous.modelSelection.model === run.modelSelection.model
      ? []
      : [
          {
            kind: "loom-model-change" as const,
            id: `loom-model-change:${run.id}`,
            createdAt: DateTime.formatIso(run.requestedAt),
            messageId: run.userMessageId,
            instanceId: run.providerInstanceId,
            fromModel: previous.modelSelection.model,
            toModel: run.modelSelection.model,
          },
        ];
  });
}

/** Splices each row in before its run's user message; a run whose message is not shown gets none. */
export function insertModelChangeRows(
  rows: MessagesTimelineRow[],
  runs: ReadonlyArray<ModelChangeRun>,
): MessagesTimelineRow[] {
  const changes = modelChangeRows(runs);
  if (changes.length === 0) return rows;
  const byMessage = new Map<string, LoomModelChangeRow>(
    changes.map((change) => [change.messageId, change]),
  );
  return rows.flatMap((row) => {
    const change = row.kind === "message" ? byMessage.get(row.id) : undefined;
    return change === undefined ? [row] : [change, row];
  });
}
