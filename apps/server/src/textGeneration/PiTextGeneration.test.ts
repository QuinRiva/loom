// loom: Loom-only test (DL-190) — upstream ships no PiTextGeneration test.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { writeFakeCli } from "../testUtils/fakeCli.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

// A pi RPC stand-in: refuses `--no-extensions` (extension-registered providers
// carry the default model), raises one confirm dialog after the prompt, and
// settles only once that dialog is cancelled.
const FAKE_PI_SOURCE = `
import { createInterface } from "node:readline";
if (process.argv.includes("--no-extensions")) {
  process.stderr.write("extensions disabled\\n");
  process.exit(12);
}
const write = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const record = JSON.parse(line);
  if (record.type === "prompt") {
    write({ type: "response", id: record.id, command: "prompt", success: true });
    write({ type: "extension_ui_request", id: "dialog-1", method: "confirm", title: "Allow?" });
  } else if (record.type === "extension_ui_response" && record.id === "dialog-1" && record.cancelled) {
    write({ type: "agent_settled" });
  } else if (record.type === "get_last_assistant_text") {
    const text = JSON.stringify({ title: "Fix login redirect", needsRefinement: false });
    write({ type: "response", id: record.id, command: record.type, success: true, data: { text } });
  }
});
`;

// Live clock: the connection's teardown waits out a real termination grace.
it.live("keeps extensions on and cancels extension dialogs during text generation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-text-" });
    const binaryPath = writeFakeCli({
      directory: path.join(dir, "bin"),
      name: "pi",
      source: FAKE_PI_SOURCE,
    });
    const textGeneration = yield* makePiTextGeneration(
      yield* Schema.decodeEffect(PiSettings)({ binaryPath }),
    );
    const result = yield* textGeneration.generateThreadTitle({
      cwd: dir,
      message: "the login redirect loops forever",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "default"),
    });
    expect(result.title).toBe("Fix login redirect");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
