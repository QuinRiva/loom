/**
 * `mcp__t3-code__ask_user_question` on V2 (P3-3, P3-26, DL-331–333, DL-347–349).
 *
 * Open: validate, open the live waiter, dispatch Loom's `runtime-request.create`
 * — a pending `user_input` request with `message` capability on its own
 * request node, so V2's panel, mobile card and `pendingRuntimeRequest` render it
 * unchanged. Answer: upstream's `runtime-request.respond`; the one
 * `Orchestrator.ts` hunk withholds upstream's answer message while the waiter
 * is live, and this module's reactor hands the waiter the rendered outcome
 * from the committed `runtime-request.updated` — the single sink for answered,
 * dismissed and closed requests.
 *
 * The reactor also closes a pending `loom-ask:` request with upstream's own
 * `thread.user-input.dismiss`: when a human message lands on the thread
 * (supersede, rule 6) and when the run that asked ends. Both read post-commit
 * state, so upstream's no-waiter answer message (resolution and message in one
 * commit) never reads as a supersede.
 *
 * @module loom/userInput/askUserQuestion
 */
import {
  CommandId,
  LOOM_ASK_REQUEST_PREFIX,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2UserInputQuestion,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { WorkstreamCaller } from "../../mcp/toolkits/workstream/authorisation.ts";
import { stableCommandId } from "../../mcp/toolkits/workstream/idempotency.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../serverActivation.ts";
import { type LoomAskClosing, LoomAskWaiters } from "./askWaiters.ts";

export class LoomAskError extends Schema.TaggedError<LoomAskError>()("LoomAskError", {
  message: Schema.String,
}) {}

type AskQuestion = Omit<OrchestrationV2UserInputQuestion, "id">;

const RESERVED_LABELS = new Set(["other", "type something."]);
const text = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * V1's rules (1–4 questions, 2–4 options, at most one recommended, no reserved
 * label). V2's question has no `recommended` slot, so the pick is shown in its
 * label and its `value` stays the plain label the answer carries.
 */
export const validateAskQuestions = (
  value: unknown,
): { readonly questions: ReadonlyArray<AskQuestion> } | { readonly error: string } => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    return { error: "questions must contain between 1 and 4 questions." };
  const questions: Array<AskQuestion> = [];
  for (const [index, raw] of value.entries()) {
    const header = text(raw?.header);
    const question = text(raw?.question);
    if (!header || !question)
      return { error: `questions[${index}] requires non-empty header and question.` };
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4)
      return { error: `questions[${index}].options must contain between 2 and 4 options.` };
    if (raw.multiSelect !== undefined && typeof raw.multiSelect !== "boolean")
      return { error: `questions[${index}].multiSelect must be a boolean when provided.` };
    if (
      raw.options.filter((option: { recommended?: unknown }) => option?.recommended === true)
        .length > 1
    )
      return {
        error: `questions[${index}] marks more than one option recommended; at most one option per question may be recommended.`,
      };
    const options: Array<AskQuestion["options"][number]> = [];
    for (const [optionIndex, option] of raw.options.entries()) {
      const label = text(option?.label);
      const description = text(option?.description);
      if (!label || !description)
        return {
          error: `questions[${index}].options[${optionIndex}] requires non-empty label and description.`,
        };
      if (RESERVED_LABELS.has(label.toLowerCase()))
        return {
          error: `Option label "${label}" is reserved by the custom-answer control; choose another label.`,
        };
      if (option.recommended !== undefined && typeof option.recommended !== "boolean")
        return {
          error: `questions[${index}].options[${optionIndex}].recommended must be a boolean when provided.`,
        };
      options.push(
        option.recommended === true
          ? { label: `${label} (Recommended)`, description, value: label }
          : { label, description },
      );
    }
    questions.push({ header, question, options, multiSelect: raw.multiSelect ?? false });
  }
  return { questions };
};

// The model-facing outcome texts are V1's (`userInputOutcome.ts`), carried over unchanged.
export const ASK_COULD_NOT_PRESENT =
  "The questions could not be presented because no live Loom pi session was available to receive them. This is a delivery failure, not a user decline: do not interpret it as the user refusing, cancelling, or choosing any option.";
const ASK_CANCELLED =
  "The questions were cancelled or interrupted without answers. Do not proceed on an assumed answer.";
const ASK_DISMISSED =
  "The user dismissed these questions without selecting an option. Proceed on the recommended option and say so; if none was marked, use your best judgement and state the assumption.";
// Rule 6: the message itself steers into this run or queues as the next turn, so the text is not repeated here.
const ASK_SUPERSEDED =
  "The user replied with a message instead of using the form, so these questions are settled. Their message reaches you separately — right after this result, or as your next turn. Do not proceed on an assumed answer and do not re-ask: read their message and respond to it.";

const answerText = (answer: unknown) =>
  Array.isArray(answer)
    ? answer.map(String).join(", ")
    : typeof answer === "string"
      ? answer
      : JSON.stringify(answer);

/** The tool result for a request that is no longer pending. */
export const renderAskOutcome = (
  request: Pick<OrchestrationV2RuntimeRequest, "status" | "answers" | "decision">,
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  closing: LoomAskClosing | undefined,
): string => {
  // Upstream's dismiss resolves the request with decision `cancel` (its node is the one cancelled).
  if (request.decision === "cancel" || request.decision === "decline")
    return closing === "superseded"
      ? ASK_SUPERSEDED
      : closing === "run-ended"
        ? ASK_CANCELLED
        : ASK_DISMISSED;
  if (request.status !== "resolved") return ASK_CANCELLED;
  const answers = request.answers ?? {};
  const lines = questions.flatMap((question) => {
    const answer = answers[question.id];
    if (answer === undefined) return [];
    const values = new Set(question.options.map((option) => option.value ?? option.label));
    const custom = Array.isArray(answer)
      ? answer.some((entry) => !values.has(entry))
      : !values.has(answer as string);
    return [`- ${question.question}: ${answerText(answer)}${custom ? " (custom answer)" : ""}`];
  });
  return ["The user answered:", ...lines].join("\n");
};

/**
 * Opens the question on the caller's own thread. The request id is
 * thread-scoped from pi's tool call id (DL-303), so a retried POST reuses the
 * receipted command and the waiter.
 */
export const openAskUserQuestion = Effect.fn("loom.askUserQuestion.open")(function* (
  caller: WorkstreamCaller,
  body: { readonly toolCallId?: unknown; readonly questions?: unknown },
) {
  const validated = validateAskQuestions(body.questions);
  if ("error" in validated) return yield* new LoomAskError({ message: validated.error });
  const key = text(body.toolCallId);
  if (key === undefined) return yield* new LoomAskError({ message: "toolCallId is required." });
  const requestId = RuntimeRequestId.make(
    `${LOOM_ASK_REQUEST_PREFIX}${encodeURIComponent(caller.threadId)}:${encodeURIComponent(key)}`,
  );
  const questions = validated.questions.map((question, index) => ({
    id: `q${index + 1}`,
    ...question,
  }));
  const waiters = yield* LoomAskWaiters;
  yield* waiters.open(requestId, caller.threadId, questions);
  yield* (yield* OrchestratorV2)
    .dispatch({
      type: "runtime-request.create",
      commandId: stableCommandId(caller, key, "ask_user_question"),
      threadId: caller.threadId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      requestId,
      questions,
    })
    .pipe(
      Effect.tapError(() => waiters.drop(requestId)),
      Effect.mapError(
        (error) =>
          new LoomAskError({
            message: `The question could not be opened: ${"cause" in error ? String(error.cause) : error.message}`,
          }),
      ),
    );
  return requestId;
});

const TERMINAL_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const isPendingAsk = (request: OrchestrationV2RuntimeRequest) =>
  request.status === "pending" && request.id.startsWith(LOOM_ASK_REQUEST_PREFIX);

const closeAsk = (threadId: ThreadId, requestId: RuntimeRequestId, closing: LoomAskClosing) =>
  Effect.gen(function* () {
    yield* (yield* LoomAskWaiters).markClosing(requestId, closing);
    yield* (yield* OrchestratorV2).dispatch({
      type: "thread.user-input.dismiss",
      commandId: CommandId.make(
        `server:loom:${closing === "superseded" ? "ask-supersede" : "ask-run-end"}:${requestId}`,
      ),
      threadId,
      requestId,
    });
  });

/** One committed domain event's effect on `loom-ask:` requests and their waiters. */
export const reactToAskEvent = Effect.fn("loom.askUserQuestion.react")(function* (
  event: OrchestrationV2DomainEvent,
) {
  if (event.type === "runtime-request.updated") {
    const request = event.payload;
    if (request.status === "pending" || !request.id.startsWith(LOOM_ASK_REQUEST_PREFIX)) return;
    const waiters = yield* LoomAskWaiters;
    const waiter = waiters.get(request.id);
    if (waiter !== undefined)
      yield* waiters.settle(
        request.id,
        renderAskOutcome(request, waiter.questions, waiter.closing),
      );
    return;
  }
  // Rule 6: a human message written after the question was asked settles it.
  if (
    event.type === "message.updated" &&
    event.payload.role === "user" &&
    event.payload.loom?.humanAuthored === true
  ) {
    const message = event.payload;
    const { runtimeRequests } = yield* (yield* OrchestratorV2).getThreadRecords(event.threadId, [
      "runtimeRequests",
    ]);
    const asked = runtimeRequests.find(
      (request) =>
        isPendingAsk(request) &&
        DateTime.toEpochMillis(request.createdAt) <= DateTime.toEpochMillis(message.createdAt),
    );
    if (asked !== undefined) yield* closeAsk(event.threadId, asked.id, "superseded");
    return;
  }
  // The run that asked ended while its question stood (an interrupt, a dead pi).
  if (event.type === "run.updated" && TERMINAL_RUN.has(event.payload.status)) {
    const records = yield* (yield* OrchestratorV2).getThreadRecords(
      event.threadId,
      ["runtimeRequests", "turnItems"],
      { turnItemTypes: ["user_input_request"], turnItemRunIds: [event.payload.id] },
    );
    for (const request of records.runtimeRequests.filter(isPendingAsk)) {
      if (
        records.turnItems.some(
          (item) => item.type === "user_input_request" && item.requestId === request.id,
        )
      )
        yield* closeAsk(event.threadId, request.id, "run-ended");
    }
  }
});

/** Runs `reactToAskEvent` over the orchestrator's live tail after activation. */
export const LoomAskReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        reactToAskEvent(event).pipe(
          Effect.catchCause((cause) => Effect.logWarning("loom.ask.react-failed", { cause })),
        ),
      ).pipe(
        Effect.catchCause((cause) => Effect.logWarning("loom.ask.reactor-stopped", { cause })),
      ),
    );
  }),
);
