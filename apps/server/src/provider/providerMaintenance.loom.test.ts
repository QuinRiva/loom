// @effect-diagnostics nodeBuiltinImport:off
/**
 * `pi update --self` must never run against the pi bundled with Loom: it would
 * replace the patched copy in node_modules (or update some other install). No
 * Loom hunk disables it — upstream's resolver already refuses any updater for a
 * `node_modules` path no package manager is proven to own. This pins that.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";

import { resolveBundledPiCliPath, resolveLoomPiBinaryPath } from "./Drivers/Pi/bundledPi.loom.ts";
import { UPDATE as PI_UPDATE } from "./Drivers/PiDriver.ts";
import { resolveProviderMaintenanceCapabilitiesEffect } from "./providerMaintenance.ts";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("maintenance resolution should not spawn a process here"),
);

it.layer(NodeServices.layer)("providerMaintenance (loom)", (it) => {
  it.effect("keeps the bundled pi manual-only: no update action", () =>
    Effect.gen(function* () {
      const binaryPath = resolveLoomPiBinaryPath("pi");
      expect(binaryPath).toBe(resolveBundledPiCliPath());
      expect(binaryPath).toMatch(
        /\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/bundle\/cli\.js$/,
      );

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(PI_UPDATE, {
        binaryPath,
        env: { PATH: process.env.PATH ?? "" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn));

      expect(capabilities).toEqual({
        provider: "pi",
        packageName: "@earendil-works/pi-coding-agent",
        update: null,
      });
    }),
  );
});
