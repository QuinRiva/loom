import { assert, it } from "@effect/vitest";
import { CommandId, ProviderDriverKind, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { deriveProviderThread, IdAllocatorV2, layer } from "./IdAllocator.ts";

const pi = ProviderDriverKind.make("pi");
const digest = (kind: string) => new RegExp(`^${kind}:[0-9a-f]{32}$`);
const threadId = ThreadId.make(
  "thread:mcp:0cc28c75-66b5-47b5-ae51-12c9f0fd72da:workstream-scaffold:5c2e3575-7687-4878-9e57-3330dabcebba:0",
);

it.effect("derived ids are a bounded, deterministic digest separated by kind", () =>
  Effect.gen(function* () {
    const { allocate, derive } = yield* IdAllocatorV2;
    const nativeItemId = `pi-item:${"x".repeat(600)}`;
    const message = derive.messageFromProviderItem({ driver: pi, nativeItemId });
    assert.match(message, digest("message"));
    assert.strictEqual(message.length, 40);
    assert.strictEqual(message, derive.messageFromProviderItem({ driver: pi, nativeItemId }));
    const others = [
      derive.messageFromProviderItem({ driver: ProviderDriverKind.make("codex"), nativeItemId }),
      derive.nodeFromProviderItem({ driver: pi, nativeItemId }),
      derive.turnItemFromProviderItem({ driver: pi, nativeItemId }),
    ];
    assert.strictEqual(new Set([message, ...others].map((id) => id.split(":")[1])).size, 4);

    const run = derive.run({ threadId, ordinal: 1 });
    const chain = [
      run,
      derive.runAttempt({ runId: run, attemptOrdinal: 1 }),
      derive.rootNodeAttempt({ runId: run, attemptOrdinal: 1 }),
      derive.runSignalTurnItem({ runId: run, signal: "interrupt-request" }),
      derive.delegatedTaskThread({ commandId: CommandId.make(`command:${threadId}`) }),
    ];
    for (const id of chain) assert.isAtMost(id.length, 53);

    assert.match(
      yield* allocate.event({
        threadId,
        commandId: CommandId.make("command:x"),
        providerSessionId: ProviderSessionId.make("provider-session:x"),
      }),
      /^event:[0-9a-f-]{36}$/,
    );
    assert.strictEqual(
      yield* allocate.checkpointScope({ threadId: ThreadId.make("thread:a b"), name: "main" }),
      "checkpoint-scope:thread:thread%3Aa%20b:name:main",
    );

    const providerThreadInput = { driver: pi, nativeThreadId: `pending:${run}` };
    assert.match(deriveProviderThread(providerThreadInput), digest("provider-thread"));
    assert.strictEqual(
      deriveProviderThread(providerThreadInput),
      derive.providerThread(providerThreadInput),
    );
  }).pipe(Effect.provide(layer)),
);
