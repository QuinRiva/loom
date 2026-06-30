/**
 * Shared live/offline orchestration-command dispatch for CLI mutations.
 *
 * Prefers a running server (so writes reach its in-memory projections and
 * shell stream immediately); falls back to an in-process orchestration engine
 * only when no live server answers. Used by the `project` and `goal` CLIs.
 */
import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type ClientOrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

export type OrchestrationCommandExecutionMode = "live" | "offline";

export class OrchestrationCliError extends Data.TaggedError("OrchestrationCliError")<{
  readonly message: string;
}> {}

export const orchestrationCliUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    () => new OrchestrationCliError({ message: "Failed to generate a command identifier." }),
  ),
);

const CliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const LIVE_SERVER_TIMEOUT = Duration.seconds(1);
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

const withCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({ scopes: AuthAdministrativeScopes, label: "t3 cli" }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const withLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(LIVE_SERVER_TIMEOUT));

const failLiveServerRequest = (cause: unknown) => {
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(
      new OrchestrationCliError({
        message: `Server request failed (${cause.code}, trace ${cause.traceId}).`,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return Effect.fail(
      new OrchestrationCliError({
        message: `Server request failed with undeclared status ${cause.response.status}.`,
      }),
    );
  }
  return Effect.fail(
    new OrchestrationCliError({ message: `Failed to call running server: ${String(cause)}.` }),
  );
};

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.orchestration.snapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  }).pipe(withLiveServerTimeout, Effect.catch(failLiveServerRequest));

const dispatchLiveOrchestrationCommand = (
  origin: string,
  bearerToken: string,
  command: ClientOrchestrationCommand,
) =>
  Effect.gen(function* () {
    const client = yield* makeLiveServerClient(origin);
    yield* client.orchestration.dispatch({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload: command,
    } as Parameters<typeof client.orchestration.dispatch>[0]);
  }).pipe(withLiveServerTimeout, Effect.catch(failLiveServerRequest));

const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  return yield* projectionSnapshotQuery.getSnapshot();
});

const tryResolveLiveExecutionMode = Effect.fn("tryResolveLiveExecutionMode")(function* (
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  config: ServerConfig["Service"],
) {
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return Option.none<{ readonly origin: string }>();
  }
  const attempt = withCliSessionToken(environmentAuth, (token) =>
    fetchLiveOrchestrationSnapshot(runtimeState.value.origin, token).pipe(
      Effect.as({ origin: runtimeState.value.origin }),
    ),
  );
  const attempted = yield* Effect.exit(attempt);
  if (Exit.isSuccess(attempted)) {
    return Option.some(attempted.value);
  }
  yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
  return Option.none<{ readonly origin: string }>();
});

export type OrchestrationMutationDispatch<Cmd extends ClientOrchestrationCommand> = (
  command: Cmd,
) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;

export interface OrchestrationMutationInput<Cmd extends ClientOrchestrationCommand> {
  readonly snapshot: OrchestrationReadModel;
  readonly dispatch: OrchestrationMutationDispatch<Cmd>;
  readonly mode: OrchestrationCommandExecutionMode;
}

export const runOrchestrationMutation = <Cmd extends ClientOrchestrationCommand>(
  flags: CliAuthLocationFlags,
  run: (
    input: OrchestrationMutationInput<Cmd>,
  ) => Effect.Effect<
    string,
    Error,
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | WorkspacePaths.WorkspacePaths
  >,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = config.logLevel;

    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const liveMode = yield* tryResolveLiveExecutionMode(environmentAuth, config);

      if (Option.isSome(liveMode)) {
        return yield* withCliSessionToken(environmentAuth, (token) =>
          Effect.gen(function* () {
            const snapshot = yield* fetchLiveOrchestrationSnapshot(liveMode.value.origin, token);
            const output = yield* run({
              snapshot,
              dispatch: (command) =>
                dispatchLiveOrchestrationCommand(liveMode.value.origin, token, command),
              mode: "live",
            });
            yield* Console.log(output);
          }),
        );
      }

      const offlineRuntimeLayer = CliRuntimeLive.pipe(
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      );

      return yield* Effect.gen(function* () {
        const snapshot = yield* getOfflineSnapshot();
        const orchestrationEngine = yield* OrchestrationEngineService;
        const output = yield* run({
          snapshot,
          dispatch: (command) =>
            orchestrationEngine.dispatch(
              command as Parameters<typeof orchestrationEngine.dispatch>[0],
            ),
          mode: "offline",
        });
        yield* Console.log(output);
      }).pipe(Effect.provide(offlineRuntimeLayer));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(ServerConfig, config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });
