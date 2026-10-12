// @effect-diagnostics nodeBuiltinImport:off
/**
 * Loom bundles pi as a workspace dependency with its patches applied at install
 * (`infra/pi-patches/README.md`), and every pi spawn runs that copy rather than
 * whatever `pi` is on PATH. Resolved once, where `PiDriver` builds its config.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// A literal so the dependency stays visible to static tooling (knip).
const BUNDLED_PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** The bundled pi's `bin.pi` (`dist/bundle/cli.js`), or undefined when it cannot be found. */
export function resolveBundledPiCliPath(): string | undefined {
  try {
    // pi's `exports` map defines only the `import` condition and never exposes
    // `./package.json`, so resolve the main entry, walk up to the package root
    // and take the CLI declared in `bin.pi`.
    let dir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve(BUNDLED_PI_PACKAGE)));
    while (dir !== NodePath.dirname(dir)) {
      const manifestPath = NodePath.join(dir, "package.json");
      if (NodeFS.existsSync(manifestPath)) {
        const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
          readonly name?: string;
          readonly bin?: string | Record<string, string>;
        };
        if (manifest.name === BUNDLED_PI_PACKAGE) {
          const binRel =
            typeof manifest.bin === "string" ? manifest.bin : (manifest.bin?.pi ?? "dist/cli.js");
          const cliPath = NodePath.join(dir, binRel);
          return NodeFS.existsSync(cliPath) ? cliPath : undefined;
        }
      }
      dir = NodePath.dirname(dir);
    }
  } catch {
    // No bundled copy; the caller falls back to `pi` on PATH.
  }
  return undefined;
}

/**
 * The binary every pi spawn uses: the default `pi` (PiSettings decodes an empty
 * setting to it) means the bundled, patched copy — spawned directly through its
 * `#!/usr/bin/env node` shebang (POSIX only); an explicit path overrides it.
 */
export const resolveLoomPiBinaryPath = (binaryPath: string): string =>
  binaryPath === "pi" ? (resolveBundledPiCliPath() ?? binaryPath) : binaryPath;
