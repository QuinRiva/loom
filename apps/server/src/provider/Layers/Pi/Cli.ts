// @effect-diagnostics nodeBuiltinImport:off
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const DEFAULT_PI_BINARY_PATH = "pi";

export interface PiInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const WINDOWS_COMMAND_SCRIPT_PATTERN = /\.(?:bat|cmd)$/i;

export function resolveBundledPiCliPath(): string | undefined {
  const req = createRequire(import.meta.url);
  for (const packageName of ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]) {
    try {
      const cliPath = join(dirname(req.resolve(`${packageName}/package.json`)), "dist", "cli.js");
      if (existsSync(cliPath)) return cliPath;
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
