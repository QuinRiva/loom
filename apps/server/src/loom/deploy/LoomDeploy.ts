/**
 * Loom deploys as the running server sees them (plans/loom-deploy-redesign/plan.mdx §4.1). The
 * runner writes the notice before it starts a server (read once, at startup); the engine and the
 * runner write the status; `loom-deploy back` POSTs `/loom/deploy/restarting`.
 */
import {
  type AuthSessionId,
  type LoomDeployEvent,
  LoomDeployNotice,
  type LoomDeployRestartReason,
  LoomDeployStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSelfUpdate from "../../cloud/selfUpdate.ts";
import { resolveServiceLauncherMode } from "../../cloud/serviceLauncherClient.ts";
import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { loomPaths } from "../loomPaths.ts";
import { LOOM_REPO_ROOT } from "../prompt/roleOverlay.ts";
import {
  estimateStopAt,
  readConfig,
  readHistory,
  realpathOr,
  releaseOfVersion,
  releasePaths,
  releaseSha,
  storeOfRelease,
} from "./store.ts";

/** Why a deploy was not started, cancelled or switched to, in words a person reads. */
export class LoomDeployRefusal extends Schema.TaggedError<LoomDeployRefusal>()(
  "LoomDeployRefusal",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

export class LoomDeploy extends Context.Service<
  LoomDeploy,
  {
    /** Broadcasts the restart warning to every open subscription. */
    readonly restarting: (
      releaseId: string,
      reason: LoomDeployRestartReason,
    ) => Effect.Effect<void>;
    /** Starts the engine's unit on the default branch, recording the pressing session's label. */
    readonly start: (sessionId: AuthSessionId) => Effect.Effect<void, LoomDeployRefusal>;
    /** Stops the engine if it has not asked for the switch. */
    readonly cancel: Effect.Effect<void, LoomDeployRefusal>;
    /** Hands a staged version to upstream's launcher; the update id once it accepts. */
    readonly switchTo: (version: string) => Effect.Effect<string, LoomDeployRefusal>;
    readonly events: Stream.Stream<LoomDeployEvent>;
  }
>()("t3/loom/deploy/LoomDeploy") {}

const decodeNotice = Schema.decodeUnknownEffect(Schema.fromJsonString(LoomDeployNotice));
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(LoomDeployStatus));

const readText = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.orElseSucceed(() => null),
  );

const warnUnreadable = (path: string) =>
  Effect.tapError((cause) => Effect.logWarning("deploy file unreadable; ignored", { path, cause }));

const reader = <A>(span: string, decode: (text: string) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.fn(span)(function* (path: string) {
    const text = yield* readText(path);
    if (text === null) return null;
    return yield* decode(text).pipe(
      warnUnreadable(path),
      Effect.orElseSucceed(() => null),
    );
  });

/** The notice or status in `path`, or null when the file is absent or does not decode. */
export const readDeployNotice = reader("LoomDeploy.readNotice", decodeNotice);
export const readDeployStatus = reader("LoomDeploy.readStatus", decodeStatus);

/** The store's configuration, when the launcher started this server from a store naming its home. */
const resolveDeployable = Effect.fn("LoomDeploy.resolveDeployable")(function* (baseDir: string) {
  const { managed } = yield* resolveServiceLauncherMode().pipe(
    Effect.orElseSucceed(() => ({ managed: false })),
  );
  if (!managed) return undefined;
  const config = yield* Effect.sync(() => {
    try {
      return readConfig(storeOfRelease(LOOM_REPO_ROOT));
    } catch {
      return undefined;
    }
  });
  return config !== undefined && realpathOr(config.home) === realpathOr(baseDir)
    ? config
    : undefined;
});

const DAY_MS = 24 * 60 * 60 * 1000;

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const runner = yield* ProcessRunner.ProcessRunner;
  const node = yield* HostProcess.ExecutablePath;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = loomPaths(serverConfig);
  const notice = yield* readDeployNotice(paths.deployNoticePath);
  const deployable = yield* resolveDeployable(serverConfig.baseDir);
  const pubsub = yield* PubSub.unbounded<LoomDeployEvent>();
  const cannot = new LoomDeployRefusal({ reason: "This server cannot deploy itself." });

  const restarting = Effect.fn("LoomDeploy.restarting")(function* (
    releaseId: string,
    reason: LoomDeployRestartReason,
  ) {
    const now = yield* DateTime.now;
    yield* PubSub.publish(pubsub, {
      type: "restarting",
      at: DateTime.formatIso(now),
      reason,
      releaseId,
    });
  });

  /** This release's own `loom-deploy`; its one-line refusal (exit 2) is the reason shown. */
  const command = Effect.fn("LoomDeploy.command")(function* (args: ReadonlyArray<string>) {
    if (deployable === undefined) return yield* cannot;
    const result = yield* runner
      .run({
        command: node,
        args: [releasePaths(LOOM_REPO_ROOT).cli, LOOM_REPO_ROOT, ...args],
        // Above `deploy`'s own 60 s wait for the release id, so a slow fetch is not reported as a failure.
        timeout: "2 minutes",
      })
      .pipe(
        Effect.mapError(
          (cause) => new LoomDeployRefusal({ reason: "loom-deploy could not run.", cause }),
        ),
      );
    if (result.code === 0) return;
    const refusal = result.stderr
      .trim()
      .split("\n")
      .at(-1)
      ?.replace(/^loom-deploy: /, "");
    return yield* new LoomDeployRefusal({
      reason:
        result.code === 2 && refusal ? refusal : `loom-deploy ${args[0]} exited ${result.code}.`,
    });
  });

  const start = Effect.fn("LoomDeploy.start")(function* (sessionId: AuthSessionId) {
    const sessions = yield* auth.listClientSessions(sessionId).pipe(Effect.orElseSucceed(() => []));
    const client = sessions.find((session) => session.current)?.client;
    const who =
      client?.label ?? ([client?.browser, client?.os].filter(Boolean).join(" on ") || "Loom");
    yield* command(["deploy", "--origin", "loom", "--who", who]);
  });

  const switchTo = Effect.fn("LoomDeploy.switchTo")(function* (version: string) {
    if (deployable === undefined) return yield* cannot;
    const releaseDir = releaseOfVersion(deployable, version);
    const releaseId = releaseDir === undefined ? version : path.basename(releaseDir);
    const result = yield* selfUpdate
      .update({ targetVersion: version }, undefined, () => restarting(releaseId, "deploy"))
      .pipe(Effect.mapError((cause) => new LoomDeployRefusal({ reason: cause.reason, cause })));
    return result.updateId ?? "";
  });

  // A one-second read of a file under 1 KB; a directory watch here would wake on every WAL write.
  const lastStatus = yield* Ref.make(yield* readText(paths.deployStatusPath));
  if (deployable !== undefined) {
    yield* Effect.gen(function* () {
      const text = yield* readText(paths.deployStatusPath);
      if (text === null || text === (yield* Ref.getAndSet(lastStatus, text))) return;
      const status = yield* decodeStatus(text).pipe(
        warnUnreadable(paths.deployStatusPath),
        Effect.option,
      );
      if (Option.isSome(status)) {
        yield* PubSub.publish(pubsub, { type: "status", status: status.value });
      }
    }).pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
  }

  const release = deployable && {
    id: path.basename(LOOM_REPO_ROOT),
    sha: releaseSha(deployable.root, LOOM_REPO_ROOT),
  };

  const events = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(pubsub);
      const head: Array<LoomDeployEvent> = [];
      if (deployable !== undefined && release !== undefined) {
        const epoch = "1970-01-01T00:00:00Z";
        const stopAt = estimateStopAt(readHistory(deployable.root), epoch);
        head.push({ type: "available", release, stopAfterSeconds: Date.parse(stopAt) / 1000 });
      }
      if (notice !== null) head.push({ type: "notice", notice });
      const status =
        deployable === undefined ? null : yield* readDeployStatus(paths.deployStatusPath);
      const now = yield* Clock.currentTimeMillis;
      if (status !== null && now - Date.parse(status.at) < DAY_MS) {
        head.push({ type: "status", status });
      }
      return Stream.concat(Stream.fromIterable(head), Stream.fromSubscription(subscription));
    }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
  );

  return LoomDeploy.of({
    restarting,
    start,
    cancel: command(["cancel"]),
    switchTo,
    events,
  });
});

export const layer = Layer.effect(LoomDeploy, make).pipe(Layer.provide(ProcessRunner.layer));
