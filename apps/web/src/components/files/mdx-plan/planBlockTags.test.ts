import { describe, expect, it } from "vite-plus/test";

import { planBlockByTag } from "./registry";
import { PLAN_BLOCK_TAGS } from "./planBlockTags";

/**
 * The worker-side unknown-tag guard reads the React-free {@link PLAN_BLOCK_TAGS}
 * set (it cannot import the React registry into a DOM-less worker). This asserts
 * that set is exactly the registry's tags, so a block added to the registry
 * without updating the constant fails CI instead of silently degrading to an
 * "unknown block" card in the worker compile path.
 */
describe("PLAN_BLOCK_TAGS", () => {
  it("matches the registry's registered tags exactly", () => {
    const registryTags = [...planBlockByTag.keys()].sort();
    const guardTags = [...PLAN_BLOCK_TAGS].sort();
    expect(guardTags).toEqual(registryTags);
  });
});
