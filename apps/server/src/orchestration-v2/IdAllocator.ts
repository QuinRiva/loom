import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  ContextHandoffId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RawEventId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import { randomUuidV4 } from "./RandomUuid.ts";

export const IdAllocatorV2Kind = Schema.Literals([
  "command",
  "event",
  "raw_event",
  "project",
  "thread",
  "message",
  "run",
  "run_attempt",
  "node",
  "provider_session",
  "provider_thread",
  "provider_turn",
  "runtime_request",
  "turn_item",
  "checkpoint_scope",
  "checkpoint",
  "context_handoff",
  "context_transfer",
  "plan",
]);
export type IdAllocatorV2Kind = typeof IdAllocatorV2Kind.Type;

export class IdAllocatorV2AllocationError extends Schema.TaggedError<IdAllocatorV2AllocationError>()(
  "IdAllocatorV2AllocationError",
  {
    kind: IdAllocatorV2Kind,
    input: Schema.optional(Schema.Unknown),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to allocate orchestration ${this.kind} id.`;
  }
}

export const IdAllocatorV2Error = Schema.Union([IdAllocatorV2AllocationError]);
export type IdAllocatorV2Error = typeof IdAllocatorV2Error.Type;

export interface IdAllocatorV2AllocateShape {
  readonly command: (input: {
    readonly fixtureName: string;
    readonly commandName: string;
  }) => Effect.Effect<CommandId, IdAllocatorV2Error>;
  readonly event: (input: {
    readonly threadId?: ThreadId;
    readonly commandId?: CommandId;
    readonly providerSessionId?: ProviderSessionId;
  }) => Effect.Effect<EventId, IdAllocatorV2Error>;
  readonly rawEvent: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly method: string | null;
  }) => Effect.Effect<RawEventId, IdAllocatorV2Error>;
  readonly project: (input: {
    readonly fixtureName: string;
  }) => Effect.Effect<ProjectId, IdAllocatorV2Error>;
  readonly thread: (input: {
    readonly fixtureName?: string;
    readonly projectId?: ProjectId;
  }) => Effect.Effect<ThreadId, IdAllocatorV2Error>;
  readonly message: (input: {
    readonly threadId: ThreadId;
    readonly ordinal: number;
  }) => Effect.Effect<MessageId, IdAllocatorV2Error>;
  readonly providerSession: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<ProviderSessionId, IdAllocatorV2Error>;
  readonly runtimeRequest: (input: {
    readonly driver: ProviderDriverKind;
    readonly providerTurnId?: ProviderTurnId;
    readonly nativeRequestId?: string;
  }) => Effect.Effect<RuntimeRequestId, IdAllocatorV2Error>;
  readonly checkpointScope: (input: {
    readonly threadId: ThreadId;
    readonly name: string;
  }) => Effect.Effect<CheckpointScopeId, IdAllocatorV2Error>;
  readonly checkpoint: (input: {
    readonly checkpointScopeId: CheckpointScopeId;
    readonly name: string;
  }) => Effect.Effect<CheckpointId, IdAllocatorV2Error>;
  readonly contextHandoff: (input: {
    readonly threadId: ThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
  }) => Effect.Effect<ContextHandoffId, IdAllocatorV2Error>;
  readonly contextTransfer: (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly type: string;
  }) => Effect.Effect<ContextTransferId, IdAllocatorV2Error>;
  readonly plan: (input: {
    readonly threadId: ThreadId;
    readonly runId?: RunId;
    readonly driver: ProviderDriverKind;
  }) => Effect.Effect<PlanId, IdAllocatorV2Error>;
}

export interface IdAllocatorV2DeriveShape {
  readonly providerSession: (input: {
    readonly providerInstanceId: ProviderInstanceId;
  }) => ProviderSessionId;
  readonly delegatedTaskNode: (input: { readonly commandId: CommandId }) => NodeId;
  readonly delegatedTaskThread: (input: { readonly commandId: CommandId }) => ThreadId;
  readonly delegatedTaskMessage: (input: { readonly commandId: CommandId }) => MessageId;
  readonly delegatedTaskTurnItem: (input: { readonly commandId: CommandId }) => TurnItemId;
  readonly createdThreadTurnItem: (input: { readonly commandId: CommandId }) => TurnItemId;
  readonly threadFromProviderThread: (input: {
    readonly driver: ProviderDriverKind;
    readonly nativeThreadId: string;
    readonly providerInstanceId?: ProviderInstanceId;
  }) => ThreadId;
  readonly run: (input: { readonly threadId: ThreadId; readonly ordinal: number }) => RunId;
  readonly runAttempt: (input: {
    readonly runId: RunId;
    readonly attemptOrdinal: number;
  }) => RunAttemptId;
  readonly rootNode: (input: { readonly runId: RunId }) => NodeId;
  readonly rootNodeAttempt: (input: {
    readonly runId: RunId;
    readonly attemptOrdinal: number;
  }) => NodeId;
  readonly userTurnItem: (input: { readonly messageId: MessageId }) => TurnItemId;
  readonly runSignalTurnItem: (input: {
    readonly runId: RunId;
    readonly signal: string;
  }) => TurnItemId;
  readonly providerThread: (input: {
    readonly driver: ProviderDriverKind;
    readonly nativeThreadId: string;
    readonly providerInstanceId?: ProviderInstanceId;
  }) => ProviderThreadId;
  readonly providerTurn: (input: {
    readonly driver: ProviderDriverKind;
    readonly nativeTurnId: string;
  }) => ProviderTurnId;
  readonly nodeFromProviderItem: (input: {
    readonly driver: ProviderDriverKind;
    readonly nativeItemId: string;
  }) => NodeId;
  readonly messageFromProviderItem: (input: {
    readonly driver: ProviderDriverKind;
    readonly nativeItemId: string;
  }) => MessageId;
  readonly turnItemFromProviderItem: (input: {
    readonly driver: ProviderDriverKind;
    readonly nativeItemId: string;
  }) => TurnItemId;
  readonly approvalNode: (input: { readonly requestId: RuntimeRequestId }) => NodeId;
  readonly approvalTurnItem: (input: { readonly requestId: RuntimeRequestId }) => TurnItemId;
}

export interface IdAllocatorV2Shape {
  readonly allocate: IdAllocatorV2AllocateShape;
  readonly derive: IdAllocatorV2DeriveShape;
}

export class IdAllocatorV2 extends Context.Service<IdAllocatorV2, IdAllocatorV2Shape>()(
  "t3/orchestration-v2/IdAllocator/IdAllocatorV2",
) {}

const encodePart = (part: string | number): string => encodeURIComponent(String(part));

const joinId = (prefix: string, ...parts: ReadonlyArray<string | number>): string =>
  [prefix, ...parts.map(encodePart)].join(":");

// loom: a derived id is its kind plus a 128-bit digest of the canonical joined form, so a
// parent id passed back in as a part can never compound into the child's length. Nothing
// parses ids (docs/orchestration-v2/entity-ids-and-correlation.md); parents live in columns.
const deriveId = (prefix: string, ...parts: ReadonlyArray<string | number>): string =>
  `${prefix}:${NodeCrypto.createHash("sha256")
    .update(joinId(prefix, ...parts))
    .digest("hex")
    .slice(0, 32)}`;

export function deriveThreadFromProviderThread(input: {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly nativeThreadId: string;
}): ThreadId {
  return ThreadId.make(
    // loom: digest form, see deriveId.
    deriveId(
      "thread",
      "provider",
      input.driver,
      ...(input.providerInstanceId === undefined
        ? []
        : ["provider-instance", input.providerInstanceId]),
      "native-thread",
      input.nativeThreadId,
    ),
  );
}

export function deriveProviderThread(input: {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly nativeThreadId: string;
}): ProviderThreadId {
  return ProviderThreadId.make(
    // loom: digest form, see deriveId.
    deriveId(
      "provider-thread",
      "provider",
      input.driver,
      ...(input.providerInstanceId === undefined
        ? []
        : ["provider-instance", input.providerInstanceId]),
      "native-thread",
      input.nativeThreadId,
    ),
  );
}

// loom: the uuid alone is the identity; the scope parts were labels nobody read, and they
// re-encoded nested ids (an event id carried its thread, command and session ids).
const randomId =
  <Id, Input>(input: {
    readonly kind: IdAllocatorV2Kind;
    readonly prefix: string;
    readonly make: (value: string) => Id;
  }) =>
  (allocationInput: Input): Effect.Effect<Id, IdAllocatorV2Error> =>
    randomUuidV4.pipe(
      Effect.map((uuid) => input.make(`${input.prefix}:${uuid}`)),
      Effect.mapError(
        (cause) =>
          new IdAllocatorV2AllocationError({
            kind: input.kind,
            input: allocationInput,
            cause,
          }),
      ),
    );

export const layer: Layer.Layer<IdAllocatorV2> = Layer.succeed(
  IdAllocatorV2,
  IdAllocatorV2.of({
    allocate: {
      command: (input) =>
        randomId<CommandId, typeof input>({
          kind: "command",
          prefix: "command",
          make: CommandId.make,
        })(input),
      event: (input) =>
        randomId<EventId, typeof input>({
          kind: "event",
          prefix: "event",
          make: EventId.make,
        })(input),
      rawEvent: (input) =>
        randomId<RawEventId, typeof input>({
          kind: "raw_event",
          prefix: "raw-event",
          make: RawEventId.make,
        })(input),
      project: (input) =>
        randomId<ProjectId, typeof input>({
          kind: "project",
          prefix: "project",
          make: ProjectId.make,
        })(input),
      thread: (input) =>
        randomId<ThreadId, typeof input>({
          kind: "thread",
          prefix: "thread",
          make: ThreadId.make,
        })(input),
      message: (input) =>
        randomId<MessageId, typeof input>({
          kind: "message",
          prefix: "message",
          make: MessageId.make,
        })(input),
      providerSession: (input) =>
        randomId<ProviderSessionId, typeof input>({
          kind: "provider_session",
          prefix: "provider-session",
          make: ProviderSessionId.make,
        })(input),
      runtimeRequest: (input) =>
        randomId<RuntimeRequestId, typeof input>({
          kind: "runtime_request",
          prefix: "runtime-request",
          make: RuntimeRequestId.make,
        })(input),
      checkpointScope: (input) =>
        Effect.succeed(
          CheckpointScopeId.make(
            joinId("checkpoint-scope", "thread", input.threadId, "name", input.name),
          ),
        ),
      checkpoint: (input) =>
        Effect.succeed(
          CheckpointId.make(
            joinId("checkpoint", "scope", input.checkpointScopeId, "name", input.name),
          ),
        ),
      contextHandoff: (input) =>
        randomId<ContextHandoffId, typeof input>({
          kind: "context_handoff",
          prefix: "context-handoff",
          make: ContextHandoffId.make,
        })(input),
      contextTransfer: (input) =>
        randomId<ContextTransferId, typeof input>({
          kind: "context_transfer",
          prefix: "context-transfer",
          make: ContextTransferId.make,
        })(input),
      plan: (input) =>
        randomId<PlanId, typeof input>({
          kind: "plan",
          prefix: "plan",
          make: PlanId.make,
        })(input),
    },
    // loom: every derive entry is deriveId (bounded digest), not joinId.
    derive: {
      providerSession: (input) =>
        ProviderSessionId.make(
          deriveId("provider-session", "provider-instance", input.providerInstanceId, "shared"),
        ),
      delegatedTaskNode: (input) =>
        NodeId.make(deriveId("node", "delegated-task", input.commandId)),
      delegatedTaskThread: (input) =>
        ThreadId.make(deriveId("thread", "delegated-task", input.commandId)),
      delegatedTaskMessage: (input) =>
        MessageId.make(deriveId("message", "delegated-task", input.commandId)),
      delegatedTaskTurnItem: (input) =>
        TurnItemId.make(deriveId("turn-item", "delegated-task", input.commandId)),
      createdThreadTurnItem: (input) =>
        TurnItemId.make(deriveId("turn-item", "created-thread", input.commandId)),
      threadFromProviderThread: deriveThreadFromProviderThread,
      run: (input) =>
        RunId.make(deriveId("run", "thread", input.threadId, "ordinal", input.ordinal)),
      runAttempt: (input) =>
        RunAttemptId.make(
          deriveId("run-attempt", "run", input.runId, "attempt", input.attemptOrdinal),
        ),
      rootNode: (input) => NodeId.make(deriveId("node", "run", input.runId, "root")),
      rootNodeAttempt: (input) =>
        NodeId.make(deriveId("node", "run", input.runId, "attempt", input.attemptOrdinal, "root")),
      userTurnItem: (input) => TurnItemId.make(deriveId("turn-item", "message", input.messageId)),
      runSignalTurnItem: (input) =>
        TurnItemId.make(deriveId("turn-item", "run", input.runId, "signal", input.signal)),
      providerThread: deriveProviderThread,
      providerTurn: (input) =>
        ProviderTurnId.make(
          deriveId("provider-turn", "provider", input.driver, "native-turn", input.nativeTurnId),
        ),
      nodeFromProviderItem: (input) =>
        NodeId.make(deriveId("node", "provider", input.driver, "native-item", input.nativeItemId)),
      messageFromProviderItem: (input) =>
        MessageId.make(
          deriveId("message", "provider", input.driver, "native-item", input.nativeItemId),
        ),
      turnItemFromProviderItem: (input) =>
        TurnItemId.make(
          deriveId("turn-item", "provider", input.driver, "native-item", input.nativeItemId),
        ),
      approvalNode: (input) => NodeId.make(deriveId("node", "runtime-request", input.requestId)),
      approvalTurnItem: (input) =>
        TurnItemId.make(deriveId("turn-item", "runtime-request", input.requestId)),
    },
  }),
);
