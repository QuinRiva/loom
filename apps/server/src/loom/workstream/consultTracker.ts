/**
 * What a `consult_thread` fork is doing, folded from its pi RPC events into the
 * {@link LoomLiveConsult} the asker's consult card renders. Pure: the caller
 * passes each event and its time, and publishes `snapshot()` when `apply`
 * reports a change. Only tool boundaries and `message_end` change it, never a
 * streamed token.
 *
 * @module loom/workstream/consultTracker
 */
import type { LoomActiveStep, LoomConsultStep, LoomLiveConsult } from "@t3tools/contracts";

import {
  piRecordField,
  piRecordNumber,
  piRecordString,
} from "../../orchestration-v2/Adapters/PiRpc.ts";

const RECENT_STEPS = 6;
const DETAIL_CHARS = 80;
const NARRATION_CHARS = 120;

/** Whitespace collapsed and clipped with an ellipsis; null when empty. */
const clip = (text: string | undefined, max: number) => {
  const flat = text?.replace(/\s+/g, " ").trim() ?? "";
  return flat.length === 0 ? null : flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A step's argument: a bash command's first line, an rg/grep pattern and path, a path, a URL or query. */
export const describeForkStep = (args: unknown): string | null => {
  const arg = (key: string) => piRecordString(args, key)?.trim() || undefined;
  const pattern = arg("pattern");
  return clip(
    arg("command")?.split("\n")[0] ??
      (pattern === undefined ? undefined : [pattern, arg("path")].filter(Boolean).join(" ")) ??
      arg("path") ??
      arg("url") ??
      arg("query"),
    DETAIL_CHARS,
  );
};

interface TrackedStep {
  readonly id: string;
  step: LoomConsultStep;
}

export const makeConsultTracker = (
  base: Pick<
    LoomLiveConsult,
    "consultId" | "askerThreadId" | "questionKey" | "targetThreadId" | "startedAt"
  >,
) => {
  let model: string | null = null;
  let forkSessionPath: string | null = null;
  let endedAt: string | null = null;
  let modelSince: string | null = null;
  let toolCalls = 0;
  let spend: LoomLiveConsult["spend"] = null;
  let narration: string | null = null;
  let recent: ReadonlyArray<TrackedStep> = [];
  // Insertion order is start order, so the first entry is the oldest in flight.
  const inFlight = new Map<string, TrackedStep>();

  const step = (): LoomActiveStep | null => {
    if (endedAt !== null) return null;
    const oldest = inFlight.values().next().value?.step;
    if (oldest !== undefined)
      return { kind: "tool", since: oldest.startedAt, title: oldest.title, detail: oldest.detail };
    return modelSince === null
      ? null
      : { kind: "model", since: modelSince, title: null, detail: null };
  };

  const close = (tracked: TrackedStep, at: string, ok: boolean) => {
    inFlight.delete(tracked.id);
    tracked.step = { ...tracked.step, endedAt: at, ok };
  };

  return {
    /** The fork is up and the question sent: its model, transcript, and the first `thinking`. */
    begin: (at: string, forkModel: string | null, sessionFile: string | null) => {
      model = forkModel;
      forkSessionPath = sessionFile;
      modelSince = at;
    },
    /** Folds one pi RPC event; true when the card's figures changed. */
    apply: (event: Record<string, unknown>, at: string): boolean => {
      const toolCallId = piRecordString(event, "toolCallId");
      switch (event["type"]) {
        case "tool_execution_start": {
          if (toolCallId === undefined) return false;
          const tracked: TrackedStep = {
            id: toolCallId,
            step: {
              title: piRecordString(event, "toolName") ?? "tool",
              detail: describeForkStep(event["args"]),
              startedAt: at,
              endedAt: null,
              ok: null,
            },
          };
          inFlight.set(toolCallId, tracked);
          recent = [...recent, tracked].slice(-RECENT_STEPS);
          toolCalls += 1;
          return true;
        }
        case "tool_execution_end": {
          const tracked = toolCallId === undefined ? undefined : inFlight.get(toolCallId);
          if (tracked === undefined) return false;
          close(tracked, at, event["isError"] !== true);
          modelSince = at;
          return true;
        }
        case "message_end": {
          const message = event["message"];
          if (piRecordString(message, "role") !== "assistant") return false;
          const usage = piRecordField(message, "usage");
          const count = (key: string) => piRecordNumber(usage, key) ?? 0;
          spend = {
            costUsd:
              (spend?.costUsd ?? 0) + (piRecordNumber(piRecordField(usage, "cost"), "total") ?? 0),
            inputTokens: (spend?.inputTokens ?? 0) + count("input"),
            outputTokens: (spend?.outputTokens ?? 0) + count("output"),
            cachedTokens: (spend?.cachedTokens ?? 0) + count("cacheRead") + count("cacheWrite"),
          };
          const content = piRecordField(message, "content");
          const text = Array.isArray(content)
            ? content
                .flatMap((block) =>
                  piRecordString(block, "type") === "text" ? [piRecordString(block, "text")] : [],
                )
                .join(" ")
            : typeof content === "string"
              ? content
              : undefined;
          // A message that only calls tools keeps the fork's last sentence.
          narration = clip(text, NARRATION_CHARS) ?? narration;
          return true;
        }
        default:
          return false;
      }
    },
    /** The consult is over: steps still running are marked as cut short. */
    end: (at: string) => {
      for (const tracked of inFlight.values()) close(tracked, at, false);
      endedAt = at;
    },
    snapshot: (): LoomLiveConsult => ({
      ...base,
      endedAt,
      model,
      step: step(),
      toolCalls,
      spend,
      recent: recent.map((tracked) => tracked.step),
      narration,
      forkSessionPath,
    }),
  };
};
