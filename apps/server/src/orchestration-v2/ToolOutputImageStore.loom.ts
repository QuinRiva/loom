import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import {
  readToolOutputImage,
  toolOutputImageBlocks,
  toolOutputImages,
  type ToolOutputImage,
} from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";

import {
  createDeterministicAttachmentId,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { inferImageExtension } from "../imageMime.ts";

/** Moves served tool-output image bytes into attachment files, so events and projections hold only an id. */
export class ToolOutputImageStore extends Context.Reference<{
  readonly persist: (item: OrchestrationV2TurnItem) => Effect.Effect<OrchestrationV2TurnItem>;
}>("t3/orchestration-v2/ToolOutputImageStore", {
  defaultValue: () => ({ persist: Effect.succeed }),
}) {}

/** Only this thread's ids qualify, as with HTML renders, so deleting a fork keeps its source's files. */
export function threadToolOutputImageAttachmentIds(
  threadId: string,
  items: Iterable<{ readonly output?: unknown }>,
): ReadonlyArray<string> {
  const segment = toSafeThreadAttachmentSegment(threadId);
  if (segment === null) return [];
  return Array.from(items).flatMap((item) =>
    toolOutputImages(item.output).flatMap(({ attachmentId }) =>
      attachmentId !== undefined && parseThreadSegmentFromAttachmentId(attachmentId) === segment
        ? [attachmentId]
        : [],
    ),
  );
}

function mapOutputBlocks(output: unknown, map: (block: unknown) => unknown): unknown {
  if (Array.isArray(output)) return output.map(map);
  if (Predicate.isObject(output) && Array.isArray(output.content)) {
    return { ...output, content: output.content.map(map) };
  }
  return map(output);
}

export const layer = Layer.effect(
  ToolOutputImageStore,
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const store = Effect.fn("ToolOutputImageStore.store")(function* (
      threadId: ThreadId,
      block: unknown,
      image: ToolOutputImage & { readonly data: string },
    ) {
      // Content-addressed per thread: repeated updates and identical screenshots share one file.
      const baseId = createDeterministicAttachmentId(threadId, `tool-output-image:${image.data}`);
      if (baseId === null) return block;
      const extension = inferImageExtension({ mimeType: image.mimeType });
      const attachmentId = `${baseId}-${extension.slice(1)}`;
      const filePath = path.join(attachmentsDir, `${attachmentId}${extension}`);
      if (!(yield* fileSystem.exists(filePath))) {
        yield* fileSystem.writeFile(`${filePath}.part`, Buffer.from(image.data, "base64"));
        yield* fileSystem.rename(`${filePath}.part`, filePath);
      }
      return { type: "image", mimeType: image.mimeType, attachmentId };
    });

    // Runs on every turn-item update, so only items carrying image bytes enter a span.
    const persist = (item: OrchestrationV2TurnItem): Effect.Effect<OrchestrationV2TurnItem> => {
      if (item.type !== "dynamic_tool") return Effect.succeed(item);
      const pending = toolOutputImageBlocks(item.output).flatMap((block) => {
        const image = readToolOutputImage(block);
        return image?.data === undefined ? [] : [{ block, image: { ...image, data: image.data } }];
      });
      if (pending.length === 0) return Effect.succeed(item);
      return Effect.forEach(pending, ({ block, image }) =>
        store(item.threadId, block, image).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Keeping tool output image inline; storing it failed.", {
              threadId: item.threadId,
              itemId: item.id,
              cause,
            }).pipe(Effect.as(block)),
          ),
          Effect.map((stored) => [block, stored] as const),
        ),
      ).pipe(
        Effect.map((entries) => {
          const stored = new Map<unknown, unknown>(entries);
          return {
            ...item,
            output: mapOutputBlocks(item.output, (block) => stored.get(block) ?? block),
          };
        }),
      );
    };
    return { persist };
  }),
);
