// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { expect } from "vite-plus/test";

import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";

import { makePiTextGeneration } from "./PiTextGeneration.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";

const modelSelection = createModelSelection(
  ProviderInstanceId.make("pi"),
  "anthropic/claude-haiku-4.5",
  [],
);

const STUB_SOURCE = [
  'import { writeFileSync } from "node:fs";',
  "writeFileSync(process.env.PI_FAKE_ARGV_PATH, JSON.stringify(process.argv.slice(2)));",
  'if (process.env.PI_FAKE_FAIL === "1") {',
  '  process.stderr.write("pi: no credentials for provider\\n");',
  "  process.exit(1);",
  "}",
  "process.stdout.write(",
  "  JSON.stringify({",
  '    type: "agent_end",',
  "    messages: [",
  '      { role: "user", content: [{ type: "text", text: "prompt" }] },',
  "      {",
  '        role: "assistant",',
  '        content: [{ type: "text", text: process.env.PI_FAKE_RESPONSE }],',
  "      },",
  "    ],",
  '  }) + "\\n",',
  ");",
  "",
].join("\n");

/** Fake `pi` CLI: records its argv, then either fails or replays a canned reply. */
function fakePiTextGeneration(options: { readonly response: string; readonly fail?: boolean }) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-pi-text-gen-"));
  const argvPath = NodePath.join(directory, "argv.json");
  const binaryPath = writeFakeCli({
    directory,
    name: "pi",
    source: STUB_SOURCE,
    env: {
      PI_FAKE_ARGV_PATH: argvPath,
      PI_FAKE_RESPONSE: options.response,
      ...(options.fail ? { PI_FAKE_FAIL: "1" } : {}),
    },
  });
  return {
    textGeneration: makePiTextGeneration({
      binaryPath,
      platform: HostProcessPlatform.defaultValue(),
      env: process.env,
      cwd: directory,
    }),
    readArgv: () => JSON.parse(NodeFS.readFileSync(argvPath, "utf8")) as ReadonlyArray<string>,
    cleanup: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
  };
}

it.effect("generates a thread title from one non-interactive pi completion", () =>
  Effect.gen(function* () {
    const pi = fakePiTextGeneration({
      response: '```json\n{ "title": "Fix login redirect loop", "needsRefinement": false }\n```',
    });

    const generated = yield* pi.textGeneration.generateThreadTitle({
      cwd: process.cwd(),
      message: "Without tools, say hello and nothing else in this message: [Use the plain form]",
      modelSelection,
    });

    expect(generated.title).toBe("Fix login redirect loop");
    expect(generated.needsRefinement).toBeUndefined();

    const argv = pi.readArgv();
    // The prompt pi runs is the shared title prompt, not the user's message.
    expect(argv.at(-1)).toContain("Generate a title that will help the user recognize");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--print",
        "--no-tools",
        "--no-context-files",
        "--provider",
        "anthropic",
        "--model",
        "claude-haiku-4.5",
      ]),
    );
    pi.cleanup();
  }),
);

it.effect("fails the title operation when the pi call fails, inventing no title", () =>
  Effect.gen(function* () {
    const pi = fakePiTextGeneration({ response: "unused", fail: true });

    const result = yield* pi.textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "Without tools, say hello",
        modelSelection,
      })
      .pipe(Effect.result);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(TextGenerationError);
      expect(result.failure.operation).toBe("generateThreadTitle");
    }
    pi.cleanup();
  }),
);
