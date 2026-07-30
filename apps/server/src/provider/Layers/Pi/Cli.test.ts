// @effect-diagnostics nodeBuiltinImport:off
/**
 * Guards that Loom runs its OWN bundled, patched pi rather than silently falling
 * back to whatever `pi` happens to be on PATH. The whole point of bundling
 * `@earendil-works/pi-coding-agent` as a `patchedDependencies` workspace dep is
 * that `resolveBundledPiCliPath()` finds the node_modules copy; a future refactor
 * that reintroduces a PATH fallback (e.g. by resolving through pi's `exports`,
 * which exposes neither the `require` condition nor `./package.json`) would make
 * this test go quiet in exactly the way that reintroduces the original bug.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { resolveBundledPiCliPath, resolvePiInvocation } from "./Cli.ts";

describe("resolveBundledPiCliPath", () => {
  it("resolves the workspace-bundled pi CLI, not a PATH install", () => {
    const cliPath = resolveBundledPiCliPath();
    expect(cliPath, "bundled pi CLI must be resolvable from node_modules").toBeDefined();
    // It is the compiled CLI entry, on disk, inside this workspace's node_modules.
    expect(cliPath!.endsWith(`${NodePath.sep}dist${NodePath.sep}cli.js`)).toBe(true);
    expect(NodeFS.existsSync(cliPath!)).toBe(true);
    expect(cliPath).toContain(`${NodePath.sep}node_modules${NodePath.sep}`);

    // The package it belongs to is the pinned pi we bundle.
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(NodePath.dirname(cliPath!), "..", "package.json"), "utf8"),
    ) as { readonly name: string };
    expect(manifest.name).toBe("@earendil-works/pi-coding-agent");
  });

  it("drives pi as `node <bundledCli>` so the RPC process is the bundled binary", () => {
    const invocation = resolvePiInvocation("pi");
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([resolveBundledPiCliPath()]);
  });
});
