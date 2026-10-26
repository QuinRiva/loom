// loom: Loom extension part: a `pgrep -f X` / `pkill -f X` in a bash call always matches its own
// tool shell (`bash -c` puts the text in argv), so such commands run base64-encoded through
// `eval`; `input` is a clone, so the transcript keeps the original. Only under 64 KiB (Linux's
// 128 KiB MAX_ARG_STRLEN); try/catch since a throwing handler blocks every tool; after the guards.
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
