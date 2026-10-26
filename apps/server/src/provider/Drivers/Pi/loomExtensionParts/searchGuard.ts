// loom: Loom extension part: the search guard. An unbounded search for a misplaced file blocks the
// turn for minutes, so it BLOCKS recursive searches rooted outside the worktree or over a vast root
// and AUTO-BOUNDS read-only search pipelines with no timeout; a `timeout`, `timeout N` prefix or
// depth bound exempts. Handlers catch everything: a throwing `tool_call` handler bricks pi's tools.
import type { LoomExtensionPart } from "../loomExtension.ts";

/**
 * Auto-injected bound (seconds) for unbounded pure-search pipelines: ~100x above every legitimate
 * search on this repo's 238k-file worktree, 10x under the first slow-tool notice (5 min). It clips
 * only a raw `grep -rn` through node_modules, which the hint redirects; a rerun can pass a timeout.
 */
export const SEARCH_GUARD_TIMEOUT_SECONDS = 30;

/**
 * The teaching escalation ladder, shared by the block reason and both hints. 99% of "file not
 * found" cases mean a wrong location assumption, and a hunted browser or linter is usually provided.
 */
const LADDER_HEAD =
  "When a file is not where you expected, searching wider almost never finds it: " +
  "you are usually in the wrong directory, repo, or worktree. Escalate in order: " +
  "(0) if what you are hunting is a tool or a capability (a browser, a simulator, a linter a skill named), it is probably provided: ";

/** Rung 0's tool clause, only where pi registered `tool_search` (it does when any tool is deferred). */
const LADDER_TOOL_SEARCH = "`tool_search` loads loom's tools, and ";

const LADDER_BASE =
  "a skill's bundled files resolve against the skill's own directory, not your cwd; " +
  "(1) verify the exact paths your brief gave you (`pwd`, `git rev-parse --show-toplevel`, `ls <path>`): brief paths are authoritative; " +
  "(2) run a focused, bounded search: a named subtree, `find <dir> -maxdepth 3 -name <name>`, or `rg --files -g <name>` inside your worktree";

const CONSULT_TOOL = "mcp__t3-code__consult_thread";

/**
 * The workstream-only rung: the consult tool exists only in a Loom thread's
 * workstream toolkit, so the guard checks pi's registry when it teaches and a
 * session without the tool is never told to call it.
 */
const LADDER_CONSULT = `; (3) only as a last resort, ask the thread that holds the context via \`${CONSULT_TOOL}\`: it is expensive, so exhaust the cheap checks first`;

const LADDER_TAIL =
  ". If you genuinely need a long search, bound it explicitly (`-maxdepth`, `--max-depth`, or a `timeout` prefix / explicit timeout parameter).";

export const searchGuardPart: LoomExtensionPart = {
  name: "search-guard",
  source: `
const path = process.getBuiltinModule("node:path");
const os = process.getBuiltinModule("node:os");

const TIMEOUT_SECONDS = ${SEARCH_GUARD_TIMEOUT_SECONDS};
// A rung naming a tool only where this session has it.
const hasTool = (name) => {
  try {
    return pi.getAllTools().some((tool) => tool.name === name);
  } catch {
    return false;
  }
};
// An already-bounded search is not told to bound itself.
const ladder = (bounded = false) =>
  ${JSON.stringify(LADDER_HEAD)} +
  (hasTool("tool_search") ? ${JSON.stringify(LADDER_TOOL_SEARCH)} : "") +
  ${JSON.stringify(LADDER_BASE)} +
  (hasTool(${JSON.stringify(CONSULT_TOOL)}) ? ${JSON.stringify(LADDER_CONSULT)} : "") +
  (bounded ? "." : ${JSON.stringify(LADDER_TAIL)});

// Recursive searchers the guard reasons about. rg/fd are gitignore-aware (a
// foreign worktree walk is usually fine); find/grep walk everything.
const WALKERS = new Set(["find", "grep", "rg", "fd"]);
// Heads considered harmless to kill mid-run: a pipeline is only auto-bounded
// when EVERY segment head is in this set (never a build, install, or write).
const SAFE_HEADS = new Set([
  "cd", "find", "grep", "rg", "fd", "ls", "head", "tail", "wc",
  "sort", "uniq", "cat", "echo", "tr", "cut", "pwd", "test", "[",
]);
// Wrapper commands whose flags/values precede the real command.
const WRAPPERS = new Set(["sudo", "nice", "command", "env", "nohup", "stdbuf", "ionice"]);
// find actions with side effects (execution or file writes): a pipeline
// containing one is never auto-bounded; a mid-run kill could leave partial
// artefacts or interrupt the exec'd command.
const FIND_SIDE_EFFECTS = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete",
  "-fprint", "-fprint0", "-fprintf", "-fls",
]);

const isWithin = (root, p) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// Known-vast roots: filesystem root, the home dir, any depth-1 directory
// (/home, /usr, /tmp, ...), and any STRICT ANCESTOR of the worktree, which
// generically covers the workspace and cockpit roots that contain every
// sibling worktree's node_modules.
const isVastRoot = (worktree, p) => {
  if (p === "/" || p === os.homedir()) return true;
  if (p !== worktree && isWithin(p, worktree)) return true;
  return p.split(path.sep).filter(Boolean).length <= 1;
};

// Split a command line into pipeline/sequence segments. Also splits at command
// substitution (\`$(\`, \`<(\`, backtick) so \`files=$(find / ...)\` exposes the
// inner walker. Quote-blind by design: a quoted separator mis-splits, but the
// guard only ever degrades to a teaching block or a no-op, never corrupts
// execution.
const splitSegments = (command) =>
  command.split(/&&|\\|\\||\\$\\(|<\\(|[;|\\n\`]/).map((s) => s.trim()).filter((s) => s.length > 0);

// Tokenise a segment: strip quotes and subshell parens, extract redirections
// (dropping operator+target from the analysis tokens, and flagging output
// redirection to a real file; a mid-run kill of such a command could leave a
// plausible-looking partial artefact), and drop leading env assignments.
const tokenise = (segment) => {
  const raw = segment
    .split(/\\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/^['"]+|['"]+$/g, "").replace(/^\\(+/, "").replace(/\\)+$/g, ""))
    .filter((t) => t.length > 0);
  const tokens = [];
  let redirectsToFile = false;
  for (let i = 0; i < raw.length; i += 1) {
    const t = raw[i];
    const m = t.match(/^(\\d*|&)(>>?|<)(.*)$/);
    if (m) {
      const rest = m[3];
      if (rest.startsWith("&")) continue; // fd dup (2>&1): drop, harmless
      const target = rest !== "" ? rest : raw[i + 1];
      if (rest === "") i += 1; // consume the separate target token
      if (m[2] !== "<" && target !== undefined && target !== "/dev/null") {
        redirectsToFile = true;
      }
      continue;
    }
    tokens.push(t);
  }
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start += 1;
  return { tokens: tokens.slice(start), redirectsToFile };
};

const headOf = (tokens) => {
  const head = tokens[0];
  return head === undefined ? undefined : path.basename(head);
};

// Strip prefix wrappers, reporting whether an explicit \`timeout N\` bound the
// command. Wrapper flags, their string/numeric values, and env assignments are
// skipped so \`env LC_ALL=C find ...\`, \`nice -n 10 find ...\`,
// \`sudo -u nobody find ...\`, and \`stdbuf -o L find ...\` all expose the
// walker. After a flag token, the next token is treated as that flag's value
// (and skipped) unless it is itself a walker or \`cd\`, so a no-value flag
// directly preceding the command (\`sudo -n find ...\`) still resolves.
const unwrapPrefixes = (tokens) => {
  let rest = tokens;
  let bounded = false;
  for (;;) {
    const head = headOf(rest);
    if (head === "timeout") {
      bounded = true;
      // timeout [opts] DURATION CMD...: skip to the token after the duration.
      let i = 1;
      while (i < rest.length && rest[i].startsWith("-")) i += 1;
      rest = rest.slice(i + 1);
    } else if (head !== undefined && WRAPPERS.has(head)) {
      rest = rest.slice(1);
      while (rest.length > 0) {
        const t = rest[0];
        if (/^\\d+$/.test(t) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
          rest = rest.slice(1);
        } else if (t.startsWith("-")) {
          rest = rest.slice(1);
          const value = rest[0];
          if (
            value !== undefined &&
            !value.startsWith("-") &&
            !WALKERS.has(path.basename(value)) &&
            path.basename(value) !== "cd" &&
            !WRAPPERS.has(path.basename(value))
          ) {
            rest = rest.slice(1); // the flag's value (e.g. -u nobody, -o L)
          }
        } else {
          break;
        }
      }
    } else {
      return { tokens: rest, bounded };
    }
  }
};

const isExpressionToken = (t) =>
  t.startsWith("-") || t === "(" || t === ")" || t === "!" || t === "\\\\(" || t === "\\\\)";

// find's actual syntax is \`find [paths...] [expression]\`: only the leading
// positionals are search roots. Anything after the first expression token
// (e.g. the file argument of \`-newer\`) is never a root.
const findRoots = (tokens) => {
  const roots = [];
  for (const t of tokens.slice(1)) {
    if (isExpressionToken(t)) break;
    roots.push(t);
  }
  return roots;
};

// Positional (non-flag) arguments of a grep/rg/fd-style search command.
const positionalArgs = (tokens) => tokens.slice(1).filter((t) => !isExpressionToken(t));

const isDepthBounded = (head, tokens) =>
  tokens.some(
    (t) =>
      t === "-maxdepth" ||
      t.startsWith("--maxdepth") ||
      t.startsWith("--max-depth") ||
      t.startsWith("--exact-depth") ||
      (head === "fd" && (t === "-d" || /^-d\\d/.test(t))),
  );

/**
 * Analyse one bash command against the worktree. Returns:
 *   { verdict: "allow" } |
 *   { verdict: "block", root, vast } |
 *   { verdict: "allow", searchy, boundedVast }   (searchy: pure unbounded search → auto-bound;
 *     boundedVast: the vast root an explicitly bounded walker covers → ladder note)
 */
const analyseBashCommand = (command, worktree) => {
  const segments = splitSegments(command);
  let cwd = worktree;
  let sawUnboundedWalker = false;
  let allSafe = segments.length > 0;
  let boundedVast;
  for (const segment of segments) {
    const parsed = tokenise(segment);
    if (parsed.redirectsToFile) allSafe = false;
    const { tokens, bounded: timeoutBounded } = unwrapPrefixes(parsed.tokens);
    const head = headOf(tokens);
    if (head === undefined) continue;
    if (!SAFE_HEADS.has(head)) allSafe = false;
    if (head === "cd") {
      const target = tokens[1];
      cwd = target === undefined ? worktree : path.resolve(cwd, target);
      continue;
    }
    if (head === "sort" && tokens.some((t) => /^-o./.test(t) || t === "-o" || t.startsWith("--output"))) {
      allSafe = false; // sort -o FILE / -oFILE / --output writes a file
    }
    if (!WALKERS.has(head)) continue;
    if (tokens.some((t) => FIND_SIDE_EFFECTS.has(t))) allSafe = false;
    // Explicitly bounded walker (timeout prefix or depth bound): the escape
    // hatch. Passes the block layer AND is never re-bound by the auto-timeout.
    const bounded = timeoutBounded || isDepthBounded(head, tokens);
    if (!bounded) sawUnboundedWalker = true;
    const recursive =
      head === "find" ||
      head === "rg" ||
      head === "fd" ||
      tokens.some((t) => t === "-r" || t === "-R" || t === "--recursive" || /^-[a-zA-Z]*[rR]/.test(t));
    if (!recursive) continue;
    // Search roots resolved against the tracked cwd. find: leading positionals
    // only. grep/rg: first positional is the pattern unless --files. Default ".".
    let paths;
    if (head === "find") {
      paths = findRoots(tokens);
    } else {
      paths = positionalArgs(tokens);
      if ((head === "grep" || head === "rg") && !tokens.includes("--files") && paths.length > 0) {
        paths = paths.slice(1);
      }
    }
    if (paths.length === 0) paths = ["."];
    for (const p of paths) {
      const resolved = path.resolve(cwd, p);
      const vast = isVastRoot(worktree, resolved);
      const foreign = !isWithin(worktree, resolved);
      // rg/fd skip gitignored trees: only vast roots are dangerous for them.
      const dangerous = head === "rg" || head === "fd" ? vast : vast || foreign;
      if (bounded) boundedVast ??= vast ? resolved : undefined;
      else if (dangerous) return { verdict: "block", root: resolved, vast };
    }
  }
  return { verdict: "allow", searchy: sawUnboundedWalker && allSafe, boundedVast };
};

const blockReason = (root) =>
  "Blocked by the t3 search guard: unbounded recursive search over " + root +
  " (outside your worktree). " + ladder();

const timeoutHint = () =>
  "\\n\\n[t3 search guard] This search was auto-bounded to " + TIMEOUT_SECONDS +
  "s because unbounded filesystem searches are the top cause of stuck threads; partial output above. " + ladder();

const boundedHint = (root) =>
  "\\n\\n[t3 search guard] Your bound let this search walk " + root + ". " + ladder(true);

// toolCallIds whose timeout the guard injected, so the timeout hint is only
// appended to timeouts the guard itself caused.
const injected = new Set();
// toolCallId -> the vast root an explicitly bounded search walked: it runs, and hears the ladder.
const boundedVast = new Map();
pi.on("tool_call", (event, ctx) => {
  try {
    if (event.toolName === "bash") {
      const command = event.input?.command;
      if (typeof command !== "string") return undefined;
      const analysis = analyseBashCommand(command, ctx.cwd);
      // An explicit tool-level timeout is the documented escape hatch: the
      // model has bounded the command itself, so neither block nor re-bound.
      const explicit = event.input.timeout !== undefined;
      const vastRoot = analysis.boundedVast ?? (explicit && analysis.vast ? analysis.root : undefined);
      if (vastRoot !== undefined) boundedVast.set(event.toolCallId, vastRoot);
      if (explicit) return undefined;
      if (analysis.verdict === "block") {
        return { block: true, reason: blockReason(analysis.root) };
      }
      if (analysis.searchy) {
        event.input.timeout = TIMEOUT_SECONDS;
        injected.add(event.toolCallId);
      }
      return undefined;
    }
    if (event.toolName === "grep" || event.toolName === "find") {
      const p = event.input?.path;
      if (typeof p !== "string") return undefined;
      const resolved = path.resolve(ctx.cwd, p);
      if (isVastRoot(ctx.cwd, resolved)) {
        return { block: true, reason: blockReason(resolved) };
      }
    }
  } catch {
    // Analyser bug → no guard, never a bricked session (a thrown tool_call
    // handler blocks ALL tool execution in pi).
  }
  return undefined;
});
pi.on("tool_result", (event) => {
  try {
    if (event.toolName !== "bash") return undefined;
    const notes = [];
    const text = event.content?.map((c) => c.text ?? "").join("\\n") ?? "";
    if (injected.delete(event.toolCallId) && event.isError && text.includes("Command timed out after")) {
      notes.push(timeoutHint());
    }
    const root = boundedVast.get(event.toolCallId);
    if (boundedVast.delete(event.toolCallId)) notes.push(boundedHint(root));
    if (notes.length === 0) return undefined;
    return { content: [...(event.content ?? []), ...notes.map((note) => ({ type: "text", text: note }))] };
  } catch {
    return undefined;
  }
});
`,
};
