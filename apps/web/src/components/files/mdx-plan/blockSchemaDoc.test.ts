// @effect-diagnostics nodeBuiltinImport:off - build-time doc drift check reads/writes a repo file; no Effect runtime here.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { generateBlockSchemaDoc } from "./blockSchemaDoc";

/**
 * Provable accuracy for the authored block reference: the doc is generated FROM
 * the live zod schemas, so this test regenerates it and asserts the checked-in
 * copy matches byte-for-byte. Any prop/type/enum drift between the schemas and
 * the skill reference fails CI (drift is exactly the bug that let an agent guess
 * `<DataModel>` `fk: true` / `kind: "n-1"`).
 *
 * Regenerate after an intentional schema change:
 *   UPDATE_BLOCK_SCHEMA=1 pnpm --filter @t3tools/web test run blockSchemaDoc
 */
const DOC_PATH = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../../../../skills/mdx-visual-plan/references/block-schema.md",
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
