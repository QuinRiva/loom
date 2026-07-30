import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../Errors.ts";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  /**
   * Routing key for the configured provider instance that owns this
   * session. The persistence layer promotes legacy null rows before
   * exposing bindings; runtime callers must not infer this from `provider`.
   */
  readonly providerInstanceId?: ProviderInstanceId;
  readonly adapterKey?: string;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
  readonly runtimeMode?: RuntimeMode;
}

export interface ProviderRuntimeBindingWithMetadata extends ProviderRuntimeBinding {
  readonly lastSeenAt: string;
}

export type ProviderSessionDirectoryReadError = ProviderSessionDirectoryPersistenceError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError;

export interface ProviderSessionDirectoryShape {
  readonly upsert: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

  readonly getProvider: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryReadError>;

  readonly getBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, ProviderSessionDirectoryReadError>;

  readonly listThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProviderSessionDirectoryPersistenceError
  >;

  readonly listBindings: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
    ProviderSessionDirectoryPersistenceError
  >;

  /**
   * loom: retention support — the fork's long-running workstream accumulates
   * stopped bindings indefinitely, and nothing upstream ever removed them.
   *
   * Drop a persisted binding, but only while it is still `stopped`.
   *
   * Used by retention sweeps to bound the runtime table. The status predicate
   * is evaluated atomically with the delete so a sweep that decided from a
   * stale listing cannot remove a binding that a concurrent start or recovery
   * has since promoted back to `running`. Reports whether a row was removed.
   */
  readonly removeIfStopped: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProviderSessionDirectoryPersistenceError>;
}

export class ProviderSessionDirectory extends Context.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("t3/provider/Services/ProviderSessionDirectory") {}
