// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const DEFAULT_PI_BINARY_PATH = "pi";

export interface PiInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const WINDOWS_COMMAND_SCRIPT_PATTERN = /\.(?:bat|cmd)$/i;

// loom: the bundled pi CLI, newest package name first. Each entry resolves its
// own literal so the dependency is visible to static tooling (knip) rather than
// hidden behind a loop variable.
const BUNDLED_PI_PACKAGES = [
  {
    name: "@earendil-works/pi-coding-agent",
    resolve: () => import.meta.resolve("@earendil-works/pi-coding-agent"),
  },
  {
    name: "@mariozechner/pi-coding-agent",
    resolve: () => import.meta.resolve("@mariozechner/pi-coding-agent"),
  },
] as const;

export function resolveBundledPiCliPath(): string | undefined {
  for (const { name: packageName, resolve } of BUNDLED_PI_PACKAGES) {
    try {
      // pi ships as ESM with an `exports` map that only defines the `import`
      // condition and never exposes `./package.json`, so neither a CJS
      // `require.resolve` nor a `/package.json` subpath resolve works. Resolve
      // the package's main entry via the `import` condition, walk up to the
      // package root, and take the CLI declared in `bin.pi` (dist/bundle/cli.js
      // since pi 0.84, dist/cli.js before that).
      let dir = NodePath.dirname(NodeURL.fileURLToPath(resolve()));
      while (dir !== NodePath.dirname(dir)) {
        const manifestPath = NodePath.join(dir, "package.json");
        if (NodeFS.existsSync(manifestPath)) {
          const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
            readonly name?: string;
            readonly bin?: string | Record<string, string>;
          };
          if (manifest.name === packageName) {
            const binRel =
              typeof manifest.bin === "string" ? manifest.bin : (manifest.bin?.pi ?? "dist/cli.js");
            const cliPath = NodePath.join(dir, binRel);
            return NodeFS.existsSync(cliPath) ? cliPath : undefined;
          }
        }
        dir = NodePath.dirname(dir);
      }
    } catch {
      // Try the next known package name.
    }
  }
  return undefined;
}

export function resolvePiInvocation(binaryPath: string): PiInvocation {
  if (binaryPath !== DEFAULT_PI_BINARY_PATH) return { command: binaryPath, args: [] };
  const bundledCliPath = resolveBundledPiCliPath();
  return bundledCliPath
    ? { command: process.execPath, args: [bundledCliPath] }
    : { command: binaryPath, args: [] };
}

export function buildPiRpcInvocation(binaryPath: string): PiInvocation {
  const invocation = resolvePiInvocation(binaryPath);
  return { ...invocation, args: [...invocation.args, "--mode", "rpc"] };
}

function stripWindowsShellQuotes(command: string): string {
  return command.startsWith('"') && command.endsWith('"') ? command.slice(1, -1) : command;
}

export function shouldUseWindowsPiShell(command: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const unquoted = stripWindowsShellQuotes(command);
  return unquoted === DEFAULT_PI_BINARY_PATH || WINDOWS_COMMAND_SCRIPT_PATTERN.test(unquoted);
}

export function quoteWindowsPiShellCommand(command: string, platform: NodeJS.Platform): string {
  if (
    platform !== "win32" ||
    !/\s/.test(command) ||
    (command.startsWith('"') && command.endsWith('"'))
  ) {
    return command;
  }
  return `"${command}"`;
}
