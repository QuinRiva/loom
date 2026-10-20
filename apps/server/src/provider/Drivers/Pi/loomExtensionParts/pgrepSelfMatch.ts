// loom: Loom extension part. pi runs a bash call as `bash -c "<command>"`, so the command text
// is in the tool shell's own argv, and procps only excludes its own PID: a `pgrep -f X` /
// `pkill -f X` in that command always matches the shell running it. `pkill -f X; …` kills the
// shell (exit 143), `while pgrep -f X; do …` never ends, and `pgrep -f X && …` is always true.
// Running such a command base64-encoded through `eval` keeps the pattern out of every argv.
// The hook's `input` is a clone, so the transcript and UI keep the original command.
//
// Under 64 KiB (bytes, not characters) only, so the encoded `-c` argument stays below Linux's
// 128 KiB MAX_ARG_STRLEN.
// Wrapped in try/catch: a throwing `tool_call` handler blocks every tool in pi.
// Registered after the search and command guards, which must analyse the original text: a
// pattern kill the command guard blocks never reaches this rewrite.
import type { LoomExtensionPart } from "../loomExtension.ts";

export const pgrepSelfMatchPart: LoomExtensionPart = {
  name: "pgrep-self-match",
  source: `
pi.on("tool_call", (event) => {
  try {
    const command = event.toolName === "bash" ? event.input?.command : undefined;
    if (typeof command === "string" && Buffer.byteLength(command) < 65536 && /\\bp(grep|kill)\\b/.test(command)) {
      event.input.command = 'eval "$(printf %s ' + Buffer.from(command).toString("base64") + ' | base64 -d)"';
    }
  } catch {}
  return undefined;
});
`,
};
