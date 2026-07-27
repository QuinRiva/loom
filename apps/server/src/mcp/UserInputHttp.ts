import type { UserInputQuestion } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  openPiAskUserQuestion,
  waitForPiAskUserQuestion,
  type PiAskUserOutcome,
  type PiAskUserPollResult,
} from "../provider/Drivers/Pi/askUserBroker.ts";
import { resolveWorkstreamScope } from "./httpScope.ts";
import { PROVIDER_TOOL_PATHS } from "./toolPaths.ts";

interface AskUserQuestionBody {
  readonly requestId?: unknown;
  readonly questions?: unknown;
}

interface RawQuestion {
  readonly header?: unknown;
  readonly question?: unknown;
  readonly stakes?: unknown;
  readonly options?: unknown;
  readonly multiSelect?: unknown;
}

interface RawOption {
  readonly label?: unknown;
  readonly description?: unknown;
  readonly preview?: unknown;
  readonly recommended?: unknown;
}

const LONG_POLL_MS = 25_000;
const RESERVED_LABELS = new Set(["other", "type something."]);
const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status });

const requiredString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

class UserInputHttpError extends Data.TaggedError("UserInputHttpError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const tryPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new UserInputHttpError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

export const validateAskUserQuestions = (
  value: unknown,
):
  | { readonly questions: ReadonlyArray<Omit<UserInputQuestion, "id">> }
  | { readonly error: string } => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    return { error: "questions must contain between 1 and 4 questions." };

  const questions: Array<Omit<UserInputQuestion, "id">> = [];
  for (const [questionIndex, raw] of value.entries()) {
    if (!raw || typeof raw !== "object")
      return { error: `questions[${questionIndex}] must be an object.` };
    const question = raw as RawQuestion;
    const header = requiredString(question.header);
    const text = requiredString(question.question);
    if (!header || !text)
      return { error: `questions[${questionIndex}] requires non-empty header and question.` };
    if (
      !Array.isArray(question.options) ||
      question.options.length < 2 ||
      question.options.length > 4
    )
      return { error: `questions[${questionIndex}].options must contain between 2 and 4 options.` };
    if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean")
      return { error: `questions[${questionIndex}].multiSelect must be a boolean when provided.` };
    const stakes = question.stakes === undefined ? undefined : requiredString(question.stakes);
    if (question.stakes !== undefined && !stakes)
      return {
        error: `questions[${questionIndex}].stakes must be a non-empty string when provided.`,
      };

    const options: Array<UserInputQuestion["options"][number]> = [];
    for (const [optionIndex, rawOption] of question.options.entries()) {
      if (!rawOption || typeof rawOption !== "object")
        return { error: `questions[${questionIndex}].options[${optionIndex}] must be an object.` };
      const option = rawOption as RawOption;
      const label = requiredString(option.label);
      const description = requiredString(option.description);
      if (!label || !description)
        return {
          error: `questions[${questionIndex}].options[${optionIndex}] requires non-empty label and description.`,
        };
      if (RESERVED_LABELS.has(label.toLowerCase()))
        return {
          error: `Option label "${label}" is reserved by Loom's custom-answer control; choose another label.`,
        };
      const preview = option.preview === undefined ? undefined : requiredString(option.preview);
      if (option.preview !== undefined && !preview)
        return {
          error: `questions[${questionIndex}].options[${optionIndex}].preview must be a non-empty string when provided.`,
        };
      if (question.multiSelect === true && preview)
        return {
          error: `questions[${questionIndex}].options[${optionIndex}].preview is only supported for single-select questions.`,
        };
      if (option.recommended !== undefined && typeof option.recommended !== "boolean")
        return {
          error: `questions[${questionIndex}].options[${optionIndex}].recommended must be a boolean when provided.`,
        };
      const recommended = option.recommended === true;
      if (recommended && options.some((existing) => existing.recommended))
        return {
          error: `questions[${questionIndex}] marks more than one option recommended; at most one option per question may be recommended.`,
        };
      options.push({
        label,
        description,
        ...(preview ? { preview } : {}),
        ...(recommended ? { recommended: true } : {}),
      });
    }
    questions.push({
      header,
      question: text,
      ...(stakes ? { stakes } : {}),
      options,
      multiSelect: question.multiSelect ?? false,
    });
  }
  return { questions };
};

const answerText = (answer: unknown): string =>
  Array.isArray(answer)
    ? answer.map(String).join(", ")
    : typeof answer === "string"
      ? answer
      : JSON.stringify(answer);

const renderOutcome = (outcome: PiAskUserOutcome) => {
  if (outcome.outcome === "could_not_present")
    return {
      pending: false as const,
      outcome: outcome.outcome,
      rendered:
        "The questions could not be presented because no live Loom pi session was available to receive them. This is a delivery failure, not a user decline: do not interpret it as the user refusing, cancelling, or choosing any option.",
    };
  if (outcome.outcome === "cancelled")
    return {
      pending: false as const,
      requestId: outcome.requestId,
      outcome: outcome.outcome,
      rendered:
        "The questions were cancelled or interrupted without answers. Do not proceed on an assumed answer.",
    };

  const answers = Object.fromEntries(
    outcome.questions.map((question) => {
      const answer = outcome.answers[question.id];
      const labels = new Set(question.options.map((option) => option.label));
      const custom = Array.isArray(answer)
        ? answer.some((value) => typeof value !== "string" || !labels.has(value))
        : typeof answer !== "string" || !labels.has(answer);
      return [question.id, { answer, custom }];
    }),
  );
  return {
    pending: false as const,
    requestId: outcome.requestId,
    outcome: outcome.outcome,
    answers,
    rendered: [
      "The user answered:",
      ...outcome.questions.map((question) => {
        const detail = answers[question.id] as { answer: unknown; custom: boolean };
        return `- ${question.question}: ${answerText(detail.answer)}${detail.custom ? " (custom answer)" : ""}`;
      }),
    ].join("\n"),
  };
};

const renderPollResult = (result: PiAskUserPollResult) =>
  result.pending ? result : renderOutcome(result);

const handleAskUserQuestion = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) return jsonError(401, "A valid provider-scoped Workstream credential is required.");

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): AskUserQuestionBody => ({})),
  )) as AskUserQuestionBody;

  if (body.requestId !== undefined) {
    const requestId = requiredString(body.requestId);
    if (!requestId) return jsonError(400, "requestId must be a non-empty string.");
    const result = yield* tryPromise(() =>
      waitForPiAskUserQuestion(scope.threadId, requestId, LONG_POLL_MS),
    );
    return result
      ? HttpServerResponse.jsonUnsafe(renderPollResult(result))
      : jsonError(404, "No pending ask_user_question request with that id belongs to this thread.");
  }

  const validated = validateAskUserQuestions(body.questions);
  if ("error" in validated) return jsonError(400, validated.error);
  const opened = yield* tryPromise(() =>
    openPiAskUserQuestion(scope.threadId, (requestId) =>
      validated.questions.map((question, index) => ({
        ...question,
        id: `${requestId}:${index + 1}`,
      })),
    ),
  );
  if ("outcome" in opened) return HttpServerResponse.jsonUnsafe(renderOutcome(opened));
  const result = yield* tryPromise(() =>
    waitForPiAskUserQuestion(scope.threadId, opened.requestId, LONG_POLL_MS),
  );
  return result
    ? HttpServerResponse.jsonUnsafe(renderPollResult(result))
    : jsonError(500, "The ask_user_question request disappeared before it could be polled.");
}).pipe(Effect.catch((error) => Effect.succeed(jsonError(500, error.message))));

export const layer = HttpRouter.add(
  "POST",
  PROVIDER_TOOL_PATHS.ask_user_question,
  handleAskUserQuestion,
);
