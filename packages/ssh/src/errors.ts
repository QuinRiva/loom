import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

export class SshHostDiscoveryError extends Data.TaggedError("SshHostDiscoveryError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class SshInvalidTargetError extends Data.TaggedError("SshInvalidTargetError")<{
  readonly message: string;
}> {}

export class SshCommandError extends Data.TaggedError("SshCommandError")<{
  readonly message: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout?: string;
  readonly cause?: unknown;
}> {}

export class SshLaunchError extends Data.TaggedError("SshLaunchError")<{
  readonly message: string;
  readonly stdout: string;
  readonly cause?: unknown;
}> {}

export class SshPairingError extends Data.TaggedError("SshPairingError")<{
  readonly message: string;
  readonly stdout: string;
  readonly cause?: unknown;
}> {}

export class SshHttpBridgeError extends Data.TaggedError("SshHttpBridgeError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class SshReadinessProbeFailedError extends Schema.TaggedErrorClass<SshReadinessProbeFailedError>()(
  "SshReadinessProbeFailedError",
  {
    requestUrl: Schema.String,
    attempt: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Backend readiness probe failed at ${this.requestUrl}.`;
  }
}

export class SshReadinessProbeTimedOutError extends Schema.TaggedErrorClass<SshReadinessProbeTimedOutError>()(
  "SshReadinessProbeTimedOutError",
  {
    requestUrl: Schema.String,
    attempt: Schema.Number,
    probeTimeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Backend readiness probe exceeded ${this.probeTimeoutMs}ms at ${this.requestUrl}.`;
  }
}

export class SshReadinessTimedOutError extends Schema.TaggedErrorClass<SshReadinessTimedOutError>()(
  "SshReadinessTimedOutError",
  {
    baseUrl: Schema.String,
    requestUrl: Schema.String,
    timeoutMs: Schema.Number,
    intervalMs: Schema.Number,
    probeTimeoutMs: Schema.Number,
    attempts: Schema.Number,
    lastFailure: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Timed out waiting ${this.timeoutMs}ms for backend readiness at ${this.baseUrl}.`;
  }
}

export const SshReadinessError = Schema.Union([
  SshReadinessProbeFailedError,
  SshReadinessProbeTimedOutError,
  SshReadinessTimedOutError,
]);
export type SshReadinessError = typeof SshReadinessError.Type;
export const isSshReadinessError = Schema.is(SshReadinessError);

export class SshPasswordPromptError extends Data.TaggedError("SshPasswordPromptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
