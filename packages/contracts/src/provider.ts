import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";
import { RuntimeErrorClass, UserInputResolvedOutcome } from "./providerRuntime.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
  // Classification of the last error (set alongside `lastError`). Lets the
  // exhaustion resume sweep find `quota_exhausted`-stalled sessions without
  // re-parsing the raw string. Absent for sessions that never errored.
  lastErrorClass: Schema.optional(RuntimeErrorClass),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  // Standing instruction appended to the session's system prompt once at
  // session spawn (e.g. the active-goal context). Not part of any turn input.
  appendSystemPrompt: Schema.optional(TrimmedNonEmptyString),
  // Role-driven pi options: skill paths (absolute, repeated `--skill`) and a
  // tool-name allowlist (`--tools`). Pi-only — other drivers drop them.
  skills: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  tools: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
  // Thread fork (MVP): when set, the driver forks this source thread's pi
  // session at the child's FIRST launch (native `pi --fork`) so the child
  // starts with a full copy of the source context, then diverges. Applied once
  // — every later resume launches normally (the child's own session file now
  // exists). Pi-only; other drivers ignore it.
  forkFromThreadId: Schema.optional(ThreadId),
  // How a fork's FIRST launch resolves its system-prompt/tool identity.
  // "replay" (default, and the only prior behaviour) replays the source's
  // captured launch argv verbatim to preserve the shared cacheable prefix.
  // "compose" uses this thread's OWN reactor-composed identity instead — for
  // forks whose role diverges from the source (e.g. a retro reviewer) and
  // whose system-level policy must differ. Deliberately forfeits the fork
  // cache-prefix optimisation. Pi-only; ignored without forkFromThreadId.
  forkIdentity: Schema.optional(Schema.Literals(["replay", "compose"])),
  // Post-completion engagement — Discuss launch (plan §5.1). When true the
  // session resumes READ-ONLY: no workstream MCP session is prepared, so the
  // launch carries no workstream extension and no `T3_WORKSTREAM_*` env and thus
  // structurally cannot mutate orchestration (submit/spawn/dispatch). The caller
  // also passes a read-only `tools` allowlist. Derived from durable thread state
  // (terminal plan lane) at launch time; never a client-set flag.
  readOnly: Schema.optional(Schema.Boolean),
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

// The question is already settled durably by the time this input exists (the
// server settles first, then delivers), so `outcome` tells the adapter WHICH
// terminal outcome to hand its waiting tool call — not whether to settle.
// Absent means `answered`; `message` carries the plain text that superseded the
// form.
export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  outcome: Schema.optional(UserInputResolvedOutcome),
  message: Schema.optional(Schema.String),
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
