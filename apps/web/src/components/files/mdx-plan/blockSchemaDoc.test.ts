// @effect-diagnostics nodeBuiltinImport:off - build-time doc drift check reads/writes a repo file; no Effect runtime here.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { generateBlockSchemaDoc } from "./blockSchemaDoc";

/**
 * The checked-in block reference must match the doc generated from the live zod schemas
 * byte-for-byte, so schema drift fails CI. Regenerate after an intentional change:
 *   UPDATE_BLOCK_SCHEMA=1 pnpm --filter @t3tools/web test run blockSchemaDoc
 */
const DOC_PATH = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../../../../skills/mdx-doc-core/references/block-schema.md",
);

describe("block-schema.md reference", () => {
  it("matches the live zod schemas", () => {
    const generated = generateBlockSchemaDoc();
    if (process.env.UPDATE_BLOCK_SCHEMA) {
      NodeFS.writeFileSync(DOC_PATH, generated);
      return;
    }
    expect(NodeFS.readFileSync(DOC_PATH, "utf8")).toBe(generated);
  });
});
