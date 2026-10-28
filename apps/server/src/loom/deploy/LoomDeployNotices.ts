/**
 * The deploy notice (plans/deploy-toasts/plan.mdx §1, loom-slack-bridge repo): deployctl writes
 * `<stateDir>/deploy-notice.json` before it starts a release and POSTs `/loom/deploy/restarting`
 * before it stops one. The file is read once, at startup, since only a restart replaces it.
 */
import {
  type LoomDeployEvent,
  LoomDeployNotice,
  type LoomDeployRestartReason,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { loomPaths } from "../loomPaths.ts";

export class LoomDeployNotices extends Context.Service<
  LoomDeployNotices,
  {
    /** Broadcasts the restart warning to every open subscription. */
    readonly restarting: (
      releaseId: string,
      reason: LoomDeployRestartReason,
    ) => Effect.Effect<void>;
    /** The startup notice (when there is one), then each restart warning. */
    readonly events: Stream.Stream<LoomDeployEvent>;
  }
>()("t3/loom/deploy/LoomDeployNotices") {}

const decodeNotice = Schema.decodeUnknownEffect(Schema.fromJsonString(LoomDeployNotice));

/** The notice in `path`, or null when the file is absent or does not decode. */
export const readDeployNotice = Effect.fn("LoomDeployNotices.read")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false)))) return null;
  return yield* fileSystem.readFileString(path).pipe(
    Effect.flatMap(decodeNotice),
    Effect.tapError((cause) =>
      Effect.logWarning("deploy notice unreadable; ignored", { path, cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
});

export const layer = Layer.effect(
  LoomDeployNotices,
  Effect.gen(function* () {
    const notice = yield* readDeployNotice(loomPaths(yield* ServerConfig).deployNoticePath);
    const pubsub = yield* PubSub.unbounded<LoomDeployEvent>();
    return {
      restarting: (releaseId, reason) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            PubSub.publish(pubsub, {
              type: "restarting",
              at: DateTime.formatIso(now),
              reason,
              releaseId,
            }),
          ),
          Effect.asVoid,
        ),
      events: Stream.concat(
        notice === null ? Stream.empty : Stream.make({ type: "notice" as const, notice }),
        Stream.fromPubSub(pubsub),
      ),
    };
  }),
);
