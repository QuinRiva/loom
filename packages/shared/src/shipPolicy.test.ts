// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveMergeAuthority, shipPolicyPromptBlock } from "./shipPolicy.ts";

const tmpDirs: Array<string> = [];
const project = (config?: string): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ship-policy-"));
  tmpDirs.push(root);
  if (config !== undefined) {
    NodeFS.mkdirSync(NodePath.join(root, ".t3code"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, ".t3code", "ship.json"), config);
  }
  return root;
};

afterEach(() => {
  while (tmpDirs.length > 0) NodeFS.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("resolveMergeAuthority", () => {
  it("defaults to human when no config is present", () => {
    expect(resolveMergeAuthority(project())).toBe("human");
  });

  it("reads agent authority and finds it from a nested subdirectory", () => {
    const root = project(JSON.stringify({ merge: { authority: "agent" } }));
    const nested = NodePath.join(root, "apps", "server", "src");
    NodeFS.mkdirSync(nested, { recursive: true });
    expect(resolveMergeAuthority(root)).toBe("agent");
    expect(resolveMergeAuthority(nested)).toBe("agent");
  });

  it("falls back to human for malformed or unknown values", () => {
    expect(resolveMergeAuthority(project("{ not json"))).toBe("human");
    expect(resolveMergeAuthority(project(JSON.stringify({ merge: { authority: "robot" } })))).toBe(
      "human",
    );
  });
});

describe("shipPolicyPromptBlock", () => {
  it("forbids agent merges under human authority and permits them under agent", () => {
    expect(shipPolicyPromptBlock("human")).toContain("HUMAN-ONLY");
    expect(shipPolicyPromptBlock("human")).toContain("gh pr merge");
    expect(shipPolicyPromptBlock("agent")).toContain("AGENT-OK");
  });

  it("agent authority names the mechanism, not just the permission", () => {
    // PE-2111 follow-up: the permissive branch once omitted the PR/ship
    // mechanism entirely, so an agent satisfied it with `git push origin main`.
    const block = shipPolicyPromptBlock("agent");
    expect(block).toContain("PR");
    expect(block).toContain("feature branch");
    expect(block).toContain("Never push directly");
  });
});
