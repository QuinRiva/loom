import { describe, expect, it } from "@effect/vitest";

import { subscriptionScopeForSelection, usageSourceInstances } from "./exhaustionMapping.ts";

describe("subscriptionScopeForSelection — instance-scoped usage sources", () => {
  it("keeps the static slug mapping for default pi subscription slugs", () => {
    const usage = usageSourceInstances({ cliproxy: { usageSources: [{}] } });
    expect(
      subscriptionScopeForSelection({ instanceId: "pi", model: "anthropic/claude-x" }, usage),
    ).toEqual({ accountKey: "claudeAgent", modelId: "claude-x", isPiSubscriptionSlug: true });
  });

  it("routes an unmapped-namespace slug to the instance when it declares usageSources", () => {
    const usage = usageSourceInstances({ cliproxy: { usageSources: [{}, {}] } });
    // cliproxy/* has no static account mapping; the configured instance meters it.
    expect(
      subscriptionScopeForSelection({ instanceId: "cliproxy", model: "cliproxy/claude-x" }, usage),
    ).toEqual({
      accountKey: "cliproxy",
      modelId: "cliproxy/claude-x",
      isPiSubscriptionSlug: false,
    });
  });

  it("stays untracked for an unmapped instance without usageSources", () => {
    expect(
      subscriptionScopeForSelection({ instanceId: "cliproxy", model: "cliproxy/claude-x" })
        .accountKey,
    ).toBeNull();
    // Empty usageSources array must not register the instance.
    const usage = usageSourceInstances({ cliproxy: { usageSources: [] } });
    expect(usage.has("cliproxy")).toBe(false);
  });
});
