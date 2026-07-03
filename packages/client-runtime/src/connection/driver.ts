import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type ConnectionAttemptStage,
  type PreparedConnection,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import { makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import * as RpcSession from "../rpc/session.ts";

export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
  }
>()("@t3tools/client-runtime/connection/driver/ConnectionDriver") {}

const AUTH_PROBE_TIMEOUT = Duration.seconds(5);

export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const httpClient = yield* HttpClient.HttpClient;

  // A browser WebSocket hides the HTTP status of a rejected upgrade, so a
  // cookie-authenticated primary connection whose socket fails to establish is
  // indistinguishable from a transient outage at the socket layer. Probe the
  // environment's auth session endpoint over HTTP: a reachable server that
  // reports the session as unauthenticated means the upgrade was rejected
  // (expired/invalid session), which is blocked-on-sign-in, not transient.
  const reclassifyEstablishmentFailure = Effect.fnUntraced(function* (
    prepared: PreparedConnection,
    error: ConnectionAttemptError,
  ) {
    if (
      error._tag !== "ConnectionTransientError" ||
      error.reason !== "transport" ||
      prepared.httpAuthorization !== null ||
      prepared.target._tag !== "PrimaryConnectionTarget"
    ) {
      return yield* error;
    }
    const authenticated = yield* makeEnvironmentHttpApiClient(prepared.httpBaseUrl).pipe(
      Effect.flatMap((client) => client.auth.session({ headers: {} })),
      Effect.map((session) => session.authenticated),
      Effect.timeoutOption(AUTH_PROBE_TIMEOUT),
      // An unreachable or failing probe proves nothing: keep the transient error.
      Effect.map(Option.getOrElse(() => true)),
      Effect.orElseSucceed(() => true),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.withSpan("ConnectionDriver.authProbe"),
    );
    return yield* authenticated
      ? error
      : new ConnectionBlockedError({
          reason: "authentication",
          detail: `Your ${prepared.label} session has expired. Sign in again to reconnect.`,
        });
  });

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    yield* reportProgress({ stage: "preparing" });
    const prepared = yield* resolver.prepare(entry);
    yield* reportProgress({ stage: "opening", prepared });
    const session = yield* sessions.connect(prepared);
    yield* reportProgress({ stage: "synchronizing", prepared });
    yield* session.ready.pipe(
      Effect.catch((error) => reclassifyEstablishmentFailure(prepared, error)),
    );
    return { prepared, session } satisfies EnvironmentConnectionLease;
  });

  return ConnectionDriver.of({ connect });
});

export const layer = Layer.effect(ConnectionDriver, make);
