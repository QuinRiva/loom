import {
  fileBasename,
  formatFilePathPosition,
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination,
  parseFileUrlHref,
  parseMarkdownFileLink,
  safeDecodeURIComponent,
  splitFilePathPosition,
  workspaceRelativeFilePath,
} from "@t3tools/client-runtime/markdown-links";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import {
  FILE_PATH_PATTERN,
  resolvePathLinkTarget,
  splitPathAndPosition,
  trimClosingDelimiters,
  URL_PATTERN,
} from "./terminal-links";
import { isTerminalLinkActivation, resolvePathLinkTarget } from "./terminal-links";

export { normalizeMarkdownLinkDestination };

const MARKDOWN_LINK_HREF_PATTERN =
  /\[[^\]]*]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
}

export function extractMarkdownLinkHrefs(markdown: string): string[] {
  const hrefs: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = (match[1] ?? match[2])?.trim();
    if (href) hrefs.push(href);
  }
  return hrefs;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function shouldOpenMarkdownFileLinkInBrowserByDefault(path: string): boolean {
  return /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

export function isWindowsDrivePathHref(href: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(safeDecodeURIComponent(href));
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

/**
 * `baseDir` anchors relative links; it defaults to the workspace root and is the
 * file's own directory when rendering a markdown file. `cwd` stays the workspace
 * root so the result still knows whether the target is inside it.
 */
export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): string | null {
  if (!href) return null;
  const target = parseMarkdownFileLink(href);
  if (!target) return null;

  const pathWithPosition = formatFilePathPosition(target);
  if (!isRelativeFilePath(pathWithPosition)) return pathWithPosition;
  if (!baseDir) return null;
  return resolvePathLinkTarget(pathWithPosition, baseDir);
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
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const trimmed = rawText.trim();
  // Windows drive/UNC paths keep their backslashes; any other backslashes are
  // relative Windows-style paths, which the downstream resolver does not
  // understand — normalize them to forward slashes.
  const text =
    WINDOWS_DRIVE_PATH_PATTERN.test(trimmed) || WINDOWS_UNC_PATH_PATTERN.test(trimmed)
      ? trimmed
      : trimmed.replaceAll("\\", "/");

  // loom: keep the Windows normalisation above, then hand the normalised span to
  // upstream's extracted candidate test so both stay in one place.
  if (!isLinkablePathText(text)) {
    // `Makefile:12` — conventional extensionless names carry no path intent of
    // their own, but the :line suffix already marked the span as a reference.
    return cwd &&
      BARE_EXTENSIONLESS_POSITION_PATTERN.test(text) &&
      EXTENSIONLESS_FILE_NAMES.has(text.replace(POSITION_SUFFIX_PATTERN, ""))
      ? buildFileLinkMetaFromTarget(resolvePathLinkTarget(text, cwd), cwd)
      : null;
  }

  const candidate = inlineCodeFilePathCandidate(text);
  return candidate === null ? null : resolveMarkdownFileLinkMeta(candidate, cwd, baseDir);
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

// Inline code spans delimited by a run of N backticks closed by the next run of
// exactly N (CommonMark). Enumerates candidate spans; the true inline/block
// split is still made by react-markdown when it decides whether a `code` node
// is inside a `pre`.
const INLINE_CODE_SPAN_PATTERN = /(`+)(?!`)((?:[^`]|`(?!\1(?!`)))+?)\1(?!`)/g;

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
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  return buildFileLinkMetaFromTarget(targetPath, cwd);
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}
