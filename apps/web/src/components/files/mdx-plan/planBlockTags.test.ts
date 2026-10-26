import { describe, expect, it } from "vite-plus/test";

import { planBlockByTag } from "./registry";
import { PLAN_BLOCK_TAGS } from "./planBlockTags";

/**
 * The worker's unknown-tag guard reads {@link PLAN_BLOCK_TAGS}, so a block added to the
 * registry without the constant would silently render as an "unknown block" card.
 */
describe("PLAN_BLOCK_TAGS", () => {
  it("matches the registry's registered tags exactly", () => {
    const registryTags = [...planBlockByTag.keys()].sort();
    const guardTags = [...PLAN_BLOCK_TAGS].sort();
    expect(guardTags).toEqual(registryTags);
  });
});
