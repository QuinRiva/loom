// loom: Loom extension part — command guards for shell mistakes agents make repeatedly. Where
// the agent's intent is obvious the command is rewritten and a note naming the mistake is
// appended to the result; where it is not, the call is blocked with the fix and the bypass:
//  - `rg -rn` (grep habit): in ripgrep `-r` is `--replace`, so `-rn` rewrites every match to
//    "n". Rewritten: the stray `r` is dropped.
//  - `pkill`, or `pgrep` output fed to `kill`: kill by pattern, which on this shared machine can
//    hit the agent's own process or another thread's server. Blocked.
//  - `pgrep -f P` where P matches the command itself: the bash tool runs `bash -c <command>`,
//    whose own command line contains P, so the check always succeeds and a polling loop runs to
//    the tool timeout. Blocked (the test is the pattern run against the command text).
//  - `gh api` with a field flag and no `-X`: gh silently switches to POST. Blocked (a read and a
//    write are equally plausible).
//  - an unquoted heredoc whose body has backticks: bash runs them as command substitution, so a
//    markdown payload arrives mangled while the API reports success. Rewritten to a quoted
//    delimiter when the body uses no `$` expansion; otherwise only a note.
// The fix cannot live in the Slack scripts: the caller's shell substitutes before they run.
//
// Same contract as the search guard: heuristic, permissive on doubt, every handler wrapped so an
// analyser bug degrades to "no guard" (a thrown `tool_call` handler blocks every tool in pi).
// Heredoc bodies are blanked before lexing so their text is never read as commands. The part
// imports nothing: `source` runs as `(pi, ctx) => { … }` in Loom's assembled extension.
import type { LoomExtensionPart } from "../loomExtension.ts";

const NOTE = "[t3 command guard]";
const BLOCKED = "Blocked by the t3 command guard:";

const KILL_MESSAGE = `${BLOCKED} killing by pattern (\`pkill\`, or \`pgrep\` output fed to \`kill\`) can kill your own agent process or another thread's server, because their command lines carry the same names and paths. Kill only a PID you captured at spawn (\`pid=$!\`), or the owner of your port from \`ss -H -ltnp\` after checking \`/proc/<pid>/cwd\`. If you are sure the match is yours, list it with \`pgrep -af <pattern>\` first, then \`kill <pid>\` with the PIDs it printed.`;

const PGREP_MESSAGE = `${BLOCKED} \`pgrep -f\` here matches the shell running this very command (its command line contains your pattern), so it always finds a process and a polling loop runs until the tool times out. To wait on a process you started, capture \`pid=$!\` at spawn and poll \`kill -0 $pid\` or \`wait $pid\`, or poll for a file the process writes when it finishes. To match by pattern anyway, use \`pgrep -fx\` or a bracket pattern like \`[v]ite\`, which cannot match its own command line.`;

const GH_MESSAGE = `${BLOCKED} \`gh api\` with \`-f\`/\`-F\`/\`--field\` and no \`-X\` sends a POST, so this would write to ENDPOINT, not read it. To see what your flags expand to, \`printf '%s\\n'\` them instead. For a read, add \`-X GET\` (the fields become query parameters). If you did mean to write, re-run with an explicit \`-X POST\` (or \`PATCH\`/\`PUT\`).`;

const RG_NOTE = `${NOTE} Rewrote FROM to TO in your rg command: in ripgrep \`-r\` means \`--replace <TEXT>\`, not recursive (rg recurses by default), so FROM would have replaced every match in the output. To really replace, use \`--replace=<text>\`.`;

const HEREDOC_REWRITE_NOTE = `${NOTE} Quoted your heredoc delimiter (FROM became TO): its body has backticks, which an unquoted heredoc runs as command substitution, so markdown arrives mangled while the API still reports success. If you wanted substitution, use \`$(...)\` instead of backticks and keep the delimiter unquoted.`;

const HEREDOC_WARN_NOTE = `${NOTE} Your unquoted heredoc FROM has backticks or \`$(\` in its body, which bash ran as command substitution before delivery. If the body was meant literally (markdown, a Slack message), send it again with a quoted delimiter (TO). If the substitution was intended, ignore this.`;

export const commandGuardsPart: LoomExtensionPart = {
  name: "command-guards",
  source: String.raw`
const MESSAGES = ${JSON.stringify({ KILL_MESSAGE, PGREP_MESSAGE, GH_MESSAGE, RG_NOTE, HEREDOC_REWRITE_NOTE, HEREDOC_WARN_NOTE })};
const fill = (text, values) => text.replace(/\b(FROM|TO|ENDPOINT)\b/g, (key) => values[key]);
const code = (text) => "\x60" + text + "\x60";

// Each heredoc whose terminator line is present: operator span, delimiter, body span.
const heredocs = (command) => {
  const found = [];
  for (const m of command.matchAll(/(?<!<)<<(-?)[ \t]*([^\s;&|<>()]+)/g)) {
    const delimiter = m[2].replace(/['"\\]/g, "");
    const newline = command.indexOf("\n", m.index);
    if (newline < 0 || delimiter === "") continue;
    let offset = newline + 1;
    for (const line of command.slice(offset).split("\n")) {
      if ((m[1] ? line.replace(/^\t+/, "") : line) === delimiter) {
        found.push({ op: m[0], start: m.index, end: m.index + m[0].length, dash: m[1], delimiter,
          quoted: delimiter !== m[2], bodyStart: newline + 1, bodyEnd: offset, body: command.slice(newline + 1, offset) });
        break;
      }
      offset += line.length + 1;
    }
  }
  return found;
};

// Quote-aware lexer: separators split commands; a word keeps its raw text and source span.
const LEX = /(&&|\|\||\$\(|[;|&\n()\x60])|((?:"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s"'\x60;|&()\\])+)/g;
const unquote = (raw) =>
  raw.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g, (_, single, double, escaped) =>
    single ?? (double !== undefined ? double.replace(/\\(.)/g, "$1") : escaped));
// Wrappers (whose flags are dropped too) and the shell keywords that can precede a command.
const WRAPPERS = new Set(["sudo", "env", "nice", "nohup", "command", "exec", "time", "timeout", "stdbuf", "xargs",
  "while", "until", "if", "elif", "then", "else", "do", "!"]);
// Commands as token lists, with leading env assignments and wrappers dropped.
const commands = (text) => {
  const out = [[]];
  for (const m of text.matchAll(LEX)) {
    if (m[1] !== undefined) out.push([]);
    else out.at(-1).push({ raw: m[2], value: unquote(m[2]), start: m.index, end: m.index + m[2].length });
  }
  return out.map((tokens) => {
    let i = 0;
    while (i < tokens.length) {
      if (/^[A-Za-z_]\w*=/.test(tokens[i].raw)) i += 1;
      else if (WRAPPERS.has(tokens[i].value)) {
        i += 1;
        while (i < tokens.length && /^(-|\d)/.test(tokens[i].raw)) i += 1;
      } else break;
    }
    return tokens.slice(i);
  }).filter((tokens) => tokens.length > 0);
};

// rg short flags that take no value: in a bundle, letters after one of these are more flags.
const RG_BOOL = "abcFHhiIlLnNopPqsSuUvwxz0";
const rgEdits = (tokens) => {
  const edits = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.raw === "--") break;
    const m = /^-([a-zA-Z0-9]*?)r([a-zA-Z0-9]*)$/.exec(t.raw);
    if (!m || ![...m[1]].every((c) => RG_BOOL.includes(c))) continue;
    const [, before, after] = m;
    const next = tokens[i + 1];
    // -rn / -nrw: the "replacement" is flag letters. -nr X: bundled, grep habit. A lone -r is a
    // mistake only when no replacement text follows (-r -n); -r 'text' is a real replace.
    const mistake = after !== ""
      ? [...after].every((c) => RG_BOOL.includes(c))
      : before !== "" || next === undefined || next.raw.startsWith("-");
    if (mistake) {
      const text = before + after === "" ? "" : "-" + before + after;
      edits.push({ start: t.start, end: t.end, text,
        note: fill(MESSAGES.RG_NOTE, { FROM: code(t.raw), TO: text === "" ? "nothing (dropped it)" : code(text) }) });
    }
  }
  return edits;
};

// pgrep short flags that take a value (the rest of the bundle, or the next word).
const PGREP_VALUED = "dgGPstuUF";
const PGREP_VALUED_LONG = /^--(delimiter|pgroup|group|parent|session|terminal|euid|uid|pidfile|ns|nslist|older|runstates|signal|cgroup)$/;
const pgrepSelfMatch = (tokens, command) => {
  let full = false;
  let exact = false;
  let ignoreCase = false;
  let pattern;
  for (let i = 1; i < tokens.length; i += 1) {
    const raw = tokens[i].raw;
    if (raw.startsWith("--")) {
      full ||= raw === "--full";
      exact ||= raw === "--exact";
      ignoreCase ||= raw === "--ignore-case";
      if (PGREP_VALUED_LONG.test(raw)) i += 1;
    } else if (raw.startsWith("-") && raw.length > 1) {
      for (let k = 1; k < raw.length; k += 1) {
        if (PGREP_VALUED.includes(raw[k])) {
          if (k === raw.length - 1) i += 1;
          break;
        }
        full ||= raw[k] === "f";
        exact ||= raw[k] === "x";
        ignoreCase ||= raw[k] === "i";
      }
    } else pattern ??= tokens[i].value;
  }
  if (!full || exact || pattern === undefined) return false;
  try {
    return new RegExp(pattern, ignoreCase ? "i" : "").test(command);
  } catch {
    return false;
  }
};

// gh api + a field flag + no explicit method (graphql is always POST, and reads that way).
const ghApiWrite = (tokens) => {
  if (tokens[1]?.value !== "api") return undefined;
  const args = tokens.slice(2).map((t) => t.value);
  if (args.includes("graphql") || args.some((a) => /^(-X|--method)/.test(a))) return undefined;
  if (!args.some((a) => /^(-[fF]|--field|--raw-field)/.test(a))) return undefined;
  return args[0] !== undefined && !args[0].startsWith("-") ? code(args[0]) : "the endpoint";
};

const KILL_PIPELINES = [/\bpgrep\b[^;&\n]*\|\s*xargs\b[^;&|\n]*\bkill\b/, /\bkill\b[^;&|\n]*(\$\(|\x60)\s*pgrep\b/];

const analyse = (command) => {
  const docs = heredocs(command);
  let text = command;
  for (const d of docs) text = text.slice(0, d.bodyStart) + d.body.replace(/[^\n]/g, " ") + text.slice(d.bodyEnd);
  const blocks = new Set();
  const edits = [];
  const notes = [];
  if (KILL_PIPELINES.some((re) => re.test(text))) blocks.add(MESSAGES.KILL_MESSAGE);
  for (const tokens of commands(text)) {
    const head = tokens[0].value.split("/").pop();
    if (head === "rg") edits.push(...rgEdits(tokens));
    else if (head === "pkill") blocks.add(MESSAGES.KILL_MESSAGE);
    else if (head === "pgrep" && pgrepSelfMatch(tokens, command)) blocks.add(MESSAGES.PGREP_MESSAGE);
    else if (head === "gh") {
      const endpoint = ghApiWrite(tokens);
      if (endpoint) blocks.add(fill(MESSAGES.GH_MESSAGE, { ENDPOINT: endpoint }));
    }
  }
  for (const d of docs) {
    const tick = /(?<!\\)\x60/.test(d.body);
    if (d.quoted || (!tick && !/(?<!\\)\$\(/.test(d.body))) continue;
    const quotedOp = "<<" + d.dash + "'" + d.delimiter + "'";
    const values = { FROM: code(d.op), TO: code(quotedOp) };
    // Rewrite only a body that expands nothing on purpose; any $VAR, braced or positional expansion means doubt.
    if (tick && !/(?<!\\)\$[\w{?#@*!$-]/.test(d.body)) {
      edits.push({ start: d.start, end: d.end, text: quotedOp, note: fill(MESSAGES.HEREDOC_REWRITE_NOTE, values) });
    } else notes.push(fill(MESSAGES.HEREDOC_WARN_NOTE, values));
  }
  if (blocks.size > 0) return { block: [...blocks].join("\n\n") };
  let rewritten = command;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, e.start) + e.text + rewritten.slice(e.end);
  }
  return { command: rewritten, notes: [...edits.map((e) => e.note), ...notes] };
};

// toolCallId -> the note appended to that call's result.
const pending = new Map();
pi.on("tool_call", (event) => {
  try {
    if (event.toolName !== "bash" || typeof event.input?.command !== "string") return undefined;
    const result = analyse(event.input.command);
    if (result.block) return { block: true, reason: result.block };
    event.input.command = result.command;
    if (result.notes.length > 0) pending.set(event.toolCallId, result.notes.join("\n\n"));
  } catch {
    // Analyser bug -> no guard, never a bricked session.
  }
  return undefined;
});
pi.on("tool_result", (event) => {
  try {
    const note = pending.get(event.toolCallId);
    if (note === undefined) return undefined;
    pending.delete(event.toolCallId);
    return { content: [...(event.content ?? []), { type: "text", text: "\n\n" + note }], structuredContent: event.structuredContent };
  } catch {
    return undefined;
  }
});
`,
};
