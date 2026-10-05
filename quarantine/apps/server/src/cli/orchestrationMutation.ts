/**
 * Shared live/offline orchestration-command dispatch for CLI mutations.
 *
 * Prefers a running server (so writes reach its in-memory projections and
 * shell stream immediately); falls back to an in-process orchestration engine
 * only when the persisted server PID is genuinely dead. Used by the `project`
 * and `goal` CLIs.
 */
import {
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type ClientOrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { readPreProvisionedCliToken } from "./cliToken.ts";
import { CLI_LIVE_SERVER_TIMEOUT, isRuntimeStateProcessAlive } from "./liveServer.ts";
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

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

const withLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(CLI_LIVE_SERVER_TIMEOUT));

const failLiveServerRequest = (cause: unknown) => {
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(
      new OrchestrationCliError({
        message:
          cause.code === "auth_invalid"
            ? "The running server rejected the pre-provisioned CLI token; restart the server to refresh it."
            : `Server request failed (${cause.code}, trace ${cause.traceId}).`,
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
  // Goal/project resolution only reads `.goals`/`.projects`; the command read
  // model returns the same shape without loading the heavy per-thread
  // activity/message tables.
  return yield* projectionSnapshotQuery.getCommandReadModel();
});

const readCliBearerToken = readPreProvisionedCliToken().pipe(
  Effect.mapError(
    (cause) =>
      new OrchestrationCliError({
        message: `Failed to read the pre-provisioned CLI token: ${String(cause)}.`,
      }),
  ),
  Effect.flatMap(
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        Effect.fail(
          new OrchestrationCliError({
            message: "The server is running but has not written the pre-provisioned CLI token yet.",
          }),
        ),
    }),
  ),
);

const tryResolveLiveExecutionMode = Effect.fn("tryResolveLiveExecutionMode")(function* (
  config: ServerConfig["Service"],
) {
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState) || !(yield* isRuntimeStateProcessAlive(runtimeState.value.pid))) {
    return Option.none<{ readonly origin: string; readonly token: string }>();
  }
  return Option.some({ origin: runtimeState.value.origin, token: yield* readCliBearerToken });
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
      const liveMode = yield* tryResolveLiveExecutionMode(config);

      if (Option.isSome(liveMode)) {
        const { origin, token } = liveMode.value;
        const snapshot = yield* fetchLiveOrchestrationSnapshot(origin, token);
        const output = yield* run({
          snapshot,
          dispatch: (command) => dispatchLiveOrchestrationCommand(origin, token, command),
          mode: "live",
        });
        return yield* Console.log(output);
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
        Layer.mergeAll(ServerSecretStore.layer, WorkspacePaths.layer).pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(ServerConfig, config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });
