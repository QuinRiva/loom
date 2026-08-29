import { formatWorkspaceRelativePath } from "./filePathDisplay";
import {
  FILE_PATH_PATTERN,
  resolvePathLinkTarget,
  splitPathAndPosition,
  trimClosingDelimiters,
  URL_PATTERN,
} from "./terminal-links";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
// Standard OS and dev-container roots; deliberately excludes app-route-ish
// prefixes like /app/ or /chat/ so SPA routes never read as files.
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/srv/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/run/",
  "/boot/",
  "/media/",
  "/workspace/",
  "/workspaces/",
] as const;

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unwrapMarkdownLinkDestination(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

export function normalizeMarkdownLinkDestination(value: string): string {
  return unwrapMarkdownLinkDestination(value.trim());
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function normalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

function parseFileUrlHref(
  href: string,
  options?: { readonly decodePath?: boolean },
): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const rawPath = parsed.pathname;
    if (rawPath.length === 0) return null;

    // Browser URL parser encodes "C:/foo" as "/C:/foo" for file URLs.
    const normalizedPath = normalizeWindowsDrivePath(rawPath);

    return {
      path: options?.decodePath === false ? normalizedPath : safeDecode(normalizedPath),
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const target = parseFileUrlHref(normalizedHref, { decodePath: false });
  if (!target) return null;
  return `${target.path}${target.hash}`;
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
): string | null {
  if (!href) return null;
  const rawHref = normalizeMarkdownLinkDestination(href);
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = normalizeWindowsDrivePath(
    fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim()),
  );
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }

  if (!cwd) return null;
  return resolvePathLinkTarget(pathWithPosition, cwd);
}

const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;
const BARE_EXTENSIONLESS_POSITION_PATTERN = /^[A-Za-z0-9_-]+(?::\d+){1,2}$/;
// Any `Name:digits` shape also matches `error:1`, `port:3000`, `TODO:12`, so
// extensionless linking is limited to conventional filenames.
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "Fastfile",
  "BUILD",
  "WORKSPACE",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);
const SINGLE_LABEL_HOSTNAMES = new Set(["localhost"]);
// Allowlists, not full public-suffix detection: treating every dotted first
// segment as a host would swallow real paths like `conf.d/x.conf` or
// `Makefile.in:12`. Extensions that double as filename suffixes (`sh`, `md`,
// `ts`, `rs`, `in`, ...) are deliberately absent from both sets.
const GENERIC_HOSTNAME_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "ai",
  "co",
  "edu",
  "gov",
  "mil",
  "info",
  "biz",
  "xyz",
  "me",
  "tv",
  "cc",
  "gg",
  "chat",
  "cloud",
  "site",
  "online",
  "tech",
  "store",
  "link",
]);
// Country codes collide with file extensions (`.pl` Perl, `.pt` PyTorch,
// `.es` ES modules), so they only count as host evidence when the candidate
// lacks a :line suffix — an explicit line reference marks a file and wins.
const COUNTRY_HOSTNAME_TLDS = new Set([
  "uk",
  "de",
  "fr",
  "nl",
  "se",
  "no",
  "fi",
  "dk",
  "pl",
  "ch",
  "at",
  "be",
  "es",
  "it",
  "pt",
  "eu",
  "us",
  "ca",
  "au",
  "nz",
  "jp",
  "kr",
  "cn",
  "br",
  "ru",
  "mx",
  "ie",
  "cz",
  "tr",
  "sg",
  "hk",
]);

/** `127.0.0.1`, `localhost`, `example.com`, `1.2.3` — hosts and versions, not files. */
function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels[labels.length - 1];
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

/**
 * Stricter gate for turning an inline-code span into a file link. Applies the
 * shared {@link isLinkablePathText} syntactic gate, then resolves the span to a
 * concrete target. Everything else is left as plain code.
 *
 */
export function resolveInlineCodeFileLinkMeta(
  rawText: string,
  cwd?: string,
): MarkdownFileLinkMeta | null {
  const trimmed = rawText.trim();
  // Windows drive/UNC paths keep their backslashes; any other backslashes are
  // relative Windows-style paths, which the downstream resolver does not
  // understand — normalize them to forward slashes.
  const text =
    WINDOWS_DRIVE_PATH_PATTERN.test(trimmed) || WINDOWS_UNC_PATH_PATTERN.test(trimmed)
      ? trimmed
      : trimmed.replaceAll("\\", "/");

  if (!isLinkablePathText(text)) {
    // `Makefile:12` — conventional extensionless names carry no path intent of
    // their own, but the :line suffix already marked the span as a reference.
    return cwd &&
      BARE_EXTENSIONLESS_POSITION_PATTERN.test(text) &&
      EXTENSIONLESS_FILE_NAMES.has(text.replace(POSITION_SUFFIX_PATTERN, ""))
      ? buildFileLinkMetaFromTarget(resolvePathLinkTarget(text, cwd), cwd)
      : null;
  }

  return resolveMarkdownFileLinkMeta(text, cwd);
}

function basenameOfPath(path: string): string {
  // A trailing separator is a valid way to write a directory, so trim it before
  // taking the final segment. Without this the segment reads as empty and the
  // chip renders with no label at all.
  const trimmed = path.replace(/[/\\]+$/, "") || path;
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

function workspaceRelativePath(path: string, workspaceRoot: string | undefined): string | null {
  if (!workspaceRoot) return null;
  const normalizedPath = normalizeWindowsDrivePath(path.replaceAll("\\", "/"));
  const normalizedRoot = normalizeWindowsDrivePath(workspaceRoot.replaceAll("\\", "/")).replace(
    /\/+$/,
    "",
  );
  const pathForCompare = normalizedPath.toLowerCase();
  const rootForCompare = normalizedRoot.toLowerCase();
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

/**
 * Extensions we are confident denote a real file when they appear as the whole
 * extension of a *bare* code span (no path separator). This is what keeps
 * property accesses like `foo.bar`, `this.state`, `Math.max` or `os.path` from
 * being mistaken for file references while still linking `package.json`,
 * `README.md`, `tsconfig.json`, etc.
 */
const KNOWN_INLINE_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "bat",
  "c",
  "cc",
  "cfg",
  "cjs",
  "clj",
  "cljs",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "cts",
  "cxx",
  "dart",
  "diff",
  "env",
  "erl",
  "ex",
  "exs",
  "fish",
  "go",
  "gql",
  "gradle",
  "graphql",
  "h",
  "hpp",
  "hs",
  "htm",
  "html",
  "ini",
  "java",
  "jl",
  "js",
  "jsdoc",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "log",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mk",
  "mts",
  "patch",
  "php",
  "pl",
  "pm",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "ico",
  "pdf",
  "properties",
  "proto",
  "ps1",
  "py",
  "pyi",
  "r",
  "rb",
  "rs",
  "sass",
  "scala",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "tf",
  "tfvars",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

// Characters that never appear in a plausible file reference but are common in
// inline code that is actually a snippet of source, a command, or a type.
const INLINE_CODE_NON_PATH_CHARS = /[\s`"'()<>{}[\]|*?!,;=$&^%]/;
const RELATIVE_PATH_INTENT_PATTERN = /^(~\/|\.{1,2}\/)/;

function extensionOf(basename: string): string | null {
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return null;
  return basename.slice(dotIndex + 1).toLowerCase();
}

function hasPathSeparator(text: string): boolean {
  return text.includes("/") || text.includes("\\");
}

/**
 * Strict, purely-syntactic gate for treating a bare string as a file path. A
 * path reference is overwhelmingly outnumbered by identifiers, commands, types,
 * prose fragments, dates, and flag values, so we only accept a string that
 * carries clear path intent: an explicit absolute/relative prefix, a known file
 * extension, or a path separator paired with a `:line` position suffix. A
 * separator alone is not enough (`a/b`, `and/or`, `01/02/2026`); a bare
 * `name:line` alone is not enough (`error:1`, `port:3000`). Shared by the
 * inline-code, prose, and code-block scanners so detection is identical
 * everywhere — a missed link is cheap, a wrong chip is noise.
 *
 * A separator or a position suffix turns a leading hostname into a URL rather
 * than a path (`example.com/index.html`, `example.com:8080`), so those shapes
 * run {@link looksLikeHostname}. A separator-less bare filename does not: its
 * extension merely collides with a country TLD (`AGENTS.md`, `notes.io`), and
 * loom verifies a chip's target exists before rendering it.
 */
export function isLinkablePathText(rawText: string): boolean {
  const text = rawText.trim();
  if (text.length === 0 || INLINE_CODE_NON_PATH_CHARS.test(text)) return false;

  const isAbsolute =
    WINDOWS_DRIVE_PATH_PATTERN.test(text) ||
    WINDOWS_UNC_PATH_PATTERN.test(text) ||
    text.startsWith("/");
  const hasRelativeIntent = RELATIVE_PATH_INTENT_PATTERN.test(text);
  const { path, line } = splitPathAndPosition(text);
  const hasPosition = line !== undefined;
  const extension = extensionOf(basenameOfPath(path));
  const hasKnownExtension = extension !== null && KNOWN_INLINE_FILE_EXTENSIONS.has(extension);

  if (
    !isAbsolute &&
    !hasRelativeIntent &&
    (hasPathSeparator(text) || hasPosition) &&
    looksLikeHostname(path.split("/")[0] ?? path, hasPosition)
  ) {
    return false;
  }

  return (
    isAbsolute ||
    hasRelativeIntent ||
    hasKnownExtension ||
    (hasPosition && (hasPathSeparator(text) || extension !== null))
  );
}

export interface TextPathSpan {
  /** The trimmed path text (trailing punctuation/delimiters removed). */
  readonly text: string;
  /** Start offset of the trimmed span within the scanned string. */
  readonly start: number;
  /** End offset (exclusive) of the trimmed span within the scanned string. */
  readonly end: number;
}

/**
 * Scan a plain string for path-like substrings, reusing the terminal link
 * patterns ({@link FILE_PATH_PATTERN}, {@link URL_PATTERN}) and trimming
 * ({@link trimClosingDelimiters}) so prose/code-block detection matches the
 * terminal exactly. URLs are excluded, trailing punctuation/unbalanced brackets
 * are trimmed, and each remaining candidate must pass the strict
 * {@link isLinkablePathText} gate. Purely syntactic — the caller still resolves
 * and existence-checks each hit before it becomes clickable, so a false
 * positive here simply stays plain text.
 */
export function matchTextPathSpans(text: string): TextPathSpan[] {
  const urlRanges: Array<readonly [number, number]> = [];
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? -1;
    if (start >= 0) urlRanges.push([start, start + match[0].length]);
  }

  const spans: TextPathSpan[] = [];
  FILE_PATH_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(FILE_PATH_PATTERN)) {
    const raw = match[0];
    const rawStart = match.index ?? -1;
    if (rawStart < 0 || raw.length === 0) continue;
    // Skip anything overlapping a URL match (e.g. the `//host/path` tail).
    if (urlRanges.some(([us, ue]) => rawStart < ue && us < rawStart + raw.length)) continue;

    const trimmed = trimClosingDelimiters(raw);
    if (trimmed.length === 0) continue;
    if (/^https?:\/\//i.test(trimmed)) continue;
    if (!isLinkablePathText(trimmed)) continue;

    // trimClosingDelimiters only removes trailing characters, so the trimmed
    // span still starts at the raw match index.
    spans.push({ text: trimmed, start: rawStart, end: rawStart + trimmed.length });
  }
  return spans;
}

/** Convenience over {@link matchTextPathSpans}: just the trimmed path strings. */
export function extractTextPathCandidates(text: string): string[] {
  return matchTextPathSpans(text).map((span) => span.text);
}

// Shared perf guards for code-block path linking. The DOM decorator
// (codePathDecorations) skips blocks/lines past these bounds, so candidate
// discovery for existence checks must apply the SAME bounds — otherwise a huge
// fenced block that is never decorated would still register unbounded path
// interest and trigger repeated stat RPCs. Single source of truth.
export const CODE_BLOCK_MAX_LINES = 400;
export const CODE_LINE_MAX_LENGTH = 2000;
// Hard ceiling on path candidates discovered from a single message's prose +
// code blocks, so no one message can produce an unbounded stat set/request
// burst regardless of content.
export const MAX_MESSAGE_PATH_CANDIDATES = 500;

const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

type MessageSegment = { readonly kind: "prose" | "code"; readonly lines: string[] };

/**
 * Split a markdown message into prose vs fenced-code segments (line-granular),
 * tracking fenced blocks (``` / ~~~, closed by an equal-or-longer run of the
 * same fence character). Indented code blocks are treated as prose here — they
 * are rare in agent output and still bounded by {@link MAX_MESSAGE_PATH_CANDIDATES}.
 */
function splitMessageSegments(text: string): MessageSegment[] {
  const lines = text.split("\n");
  const segments: MessageSegment[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length > 0) {
      segments.push({ kind: "prose", lines: prose });
      prose = [];
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const open = FENCE_LINE_PATTERN.exec(line);
    if (!open) {
      prose.push(line);
      continue;
    }
    flushProse();
    const fence = open[1] ?? "```";
    const fenceChar = fence[0] === "~" ? "~" : "`";
    const closePattern = new RegExp(`^ {0,3}\\${fenceChar}{${fence.length},}\\s*$`);
    const codeLines: string[] = [];
    index += 1;
    while (index < lines.length && !closePattern.test(lines[index] ?? "")) {
      codeLines.push(lines[index] ?? "");
      index += 1;
    }
    // `index` now sits on the closing fence (or past the end); the outer loop's
    // increment steps over it.
    segments.push({ kind: "code", lines: codeLines });
  }
  flushProse();
  return segments;
}

/**
 * Existence-candidate path strings for a whole message, aligned with what the
 * renderers will actually attempt to link and bounded so a single message can
 * never produce an unbounded stat set. Prose segments are scanned in full;
 * fenced-code segments are scanned line-by-line and skipped entirely when they
 * exceed {@link CODE_BLOCK_MAX_LINES} (matching the DOM decorator), with
 * over-length lines skipped. The total is capped at
 * {@link MAX_MESSAGE_PATH_CANDIDATES}, prose first so ordinary prose paths stay
 * eligible even when a large in-bounds code block follows.
 */
export function extractMessagePathCandidates(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (candidate: string): boolean => {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
    return out.length < MAX_MESSAGE_PATH_CANDIDATES;
  };

  const segments = splitMessageSegments(text);
  // Prose before code so the cap never starves prose paths of eligibility.
  const ordered = [
    ...segments.filter((segment) => segment.kind === "prose"),
    ...segments.filter((segment) => segment.kind === "code"),
  ];
  for (const segment of ordered) {
    if (out.length >= MAX_MESSAGE_PATH_CANDIDATES) break;
    if (segment.kind === "code" && segment.lines.length > CODE_BLOCK_MAX_LINES) continue;
    const scanLines = segment.kind === "code" ? segment.lines : [segment.lines.join("\n")];
    for (const line of scanLines) {
      if (segment.kind === "code" && line.length > CODE_LINE_MAX_LENGTH) continue;
      for (const span of matchTextPathSpans(line)) {
        if (!add(span.text)) return out;
      }
    }
  }
  return out;
}

function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/**
 * A same-message reference usable as a base directory for resolving a bare
 * filename against. Only an unambiguous, syntactic directory signal qualifies:
 * a trailing path separator (`~/foo/`, `/abs/dir/`). Returns the normalised
 * directory path (no trailing separator) or null. This is deliberately not a
 * heuristic — an extension-less span like `README` or `Makefile` is a plausible
 * file and must not be guessed to be a directory.
 */
export function directoryReferenceBase(filePath: string): string | null {
  if (!/[\\/]$/.test(filePath)) return null;
  const normalized = stripTrailingSeparators(filePath);
  return normalized.length > 0 ? normalized : null;
}

function isBareOrUnprefixedRelativePath(text: string): boolean {
  if (text.startsWith("/")) return false;
  if (WINDOWS_DRIVE_PATH_PATTERN.test(text) || WINDOWS_UNC_PATH_PATTERN.test(text)) return false;
  // Explicit `~/`, `./`, `../` name an unambiguous location — never expanded.
  return !RELATIVE_PATH_PREFIX_PATTERN.test(text);
}

/**
 * Ordered chip-target candidates for an inline-code path span.
 *
 * A bare filename (or a relative path without an explicit `~/`/`./`/`../`
 * prefix) resolves first against `cwd` (current behaviour), then against each
 * same-message directory reference in `candidateDirectories`. Absolute, `~/`,
 * and explicit-relative spans name a single unambiguous location and yield just
 * that one candidate. The caller binds the chip to the first candidate confirmed
 * to exist as a file, so `cwd` wins when the filename exists in several places
 * and the ordering of `candidateDirectories` (message appearance order) breaks
 * remaining ties deterministically.
 */
export function resolveInlineCodeFileLinkCandidates(
  rawText: string,
  cwd: string | undefined,
  candidateDirectories: readonly string[],
): MarkdownFileLinkMeta[] {
  const base = resolveInlineCodeFileLinkMeta(rawText, cwd);
  if (!base) return [];
  const text = rawText.trim();
  if (!isBareOrUnprefixedRelativePath(text)) return [base];

  const candidates = [base];
  const seen = new Set([base.filePath]);
  for (const directory of candidateDirectories) {
    const meta = resolveMarkdownFileLinkMeta(`${stripTrailingSeparators(directory)}/${text}`, cwd);
    if (meta && !seen.has(meta.filePath)) {
      seen.add(meta.filePath);
      candidates.push(meta);
    }
  }
  return candidates;
}

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
// Inline code spans delimited by a run of N backticks closed by the next run of
// exactly N (CommonMark). Enumerates candidate spans; the true inline/block
// split is still made by react-markdown when it decides whether a `code` node
// is inside a `pre`.
const INLINE_CODE_SPAN_PATTERN = /(`+)(?!`)((?:[^`]|`(?!\1(?!`)))+?)\1(?!`)/g;

export function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (href) hrefs.push(href);
  }
  return hrefs;
}

export function extractInlineCodeSpanTexts(text: string): string[] {
  const spans: string[] = [];
  for (const match of text.matchAll(INLINE_CODE_SPAN_PATTERN)) {
    const trimmed = match[2]?.trim();
    if (trimmed) spans.push(trimmed);
  }
  return spans;
}

export function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  return rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
}

/**
 * Directory references named anywhere in a message, in appearance order, so a
 * bare filename can be resolved against a folder mentioned in the same message
 * (e.g. a `_findings/` folder plus a bare `verdict.md`). Combines inline-code
 * path spans and explicit markdown links, resolves each against `cwd`, and keeps
 * those that carry a syntactic directory signal ({@link directoryReferenceBase}).
 * Purely syntactic — no existence lookup — so it cannot feed back into the
 * existence request set; a directory named *after* the filename is still found
 * because the whole message is scanned.
 */
export function collectMessageDirectoryBases(text: string, cwd: string | undefined): string[] {
  const refs: Array<{ offset: number; meta: MarkdownFileLinkMeta | null }> = [];
  for (const match of text.matchAll(INLINE_CODE_SPAN_PATTERN)) {
    const span = match[2]?.trim();
    if (span)
      refs.push({ offset: match.index ?? 0, meta: resolveInlineCodeFileLinkMeta(span, cwd) });
  }
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (href) {
      refs.push({
        offset: match.index ?? 0,
        meta: resolveMarkdownFileLinkMeta(normalizeMarkdownLinkHrefKey(href), cwd),
      });
    }
  }
  refs.sort((a, b) => a.offset - b.offset);

  const bases: string[] = [];
  const seen = new Set<string>();
  for (const { meta } of refs) {
    if (!meta) continue;
    const base = directoryReferenceBase(meta.filePath);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    bases.push(base);
  }
  return bases;
}

interface ChipExistence {
  readonly exists: boolean;
  readonly isDirectory: boolean;
}

/**
 * Bind a chip to the first candidate confirmed to exist, walking in priority
 * order (cwd, then message directories). A higher-priority candidate that is
 * still unverified (`lookupExistence` returns undefined) blocks binding — the
 * caller renders inert and waits — so the choice is deterministic and never
 * flickers from a lower- to a higher-priority target. Returns null when no
 * candidate is bindable yet (a leading candidate unverified, or all confirmed
 * missing).
 */
export function selectChipBinding(
  candidates: readonly MarkdownFileLinkMeta[],
  lookupExistence: (filePath: string) => ChipExistence | undefined,
): { meta: MarkdownFileLinkMeta; isDirectory: boolean } | null {
  for (const meta of candidates) {
    const existence = lookupExistence(meta.filePath);
    if (!existence) return null;
    if (!existence.exists) continue;
    return { meta, isDirectory: existence.isDirectory };
  }
  return null;
}

/**
 * Whether a resolved file path can be served by the out-of-workspace read-only
 * preview surface. Only POSIX absolute paths qualify: the server reads them with
 * host `path.isAbsolute`, so a Windows drive path (`C:\…`) would be rejected on a
 * POSIX host and must instead fall back to the editor. Preview initially targets
 * POSIX absolute paths by design; everything else defers to the editor.
 */
export function isAbsolutePreviewablePath(path: string): boolean {
  return path.startsWith("/");
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  if (!targetPath) return null;
  return buildFileLinkMetaFromTarget(targetPath, cwd);
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = splitPathAndPosition(targetPath);
  const parsedLine = line ? Number.parseInt(line, 10) : Number.NaN;
  const parsedColumn = column ? Number.parseInt(column, 10) : Number.NaN;
  const lineNumber = Number.isFinite(parsedLine) ? parsedLine : undefined;
  const columnNumber = Number.isFinite(parsedColumn) ? parsedColumn : undefined;

  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativePath(path, cwd),
    basename: basenameOfPath(path),
    ...(lineNumber !== undefined ? { line: lineNumber } : {}),
    ...(columnNumber !== undefined ? { column: columnNumber } : {}),
  };
}
