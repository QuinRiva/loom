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
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  splitPathAndPosition,
} from "./terminal-links";

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

  // loom: both arms below are loom's (upstream's copy of this module only
  // delegates to `inlineCodeFilePathCandidate`).
  if (!isLinkablePathText(text)) {
    // `Makefile:12` — conventional extensionless names carry no path intent of
    // their own, but the :line suffix already marked the span as a reference.
    return BARE_EXTENSIONLESS_POSITION_PATTERN.test(text) &&
      EXTENSIONLESS_FILE_NAMES.has(text.replace(POSITION_SUFFIX_PATTERN, ""))
      ? resolveMarkdownFileLinkMeta(text, cwd, baseDir)
      : null;
  }

  // loom: upstream's candidate test additionally demands a path separator or a
  // `:line` suffix, so a bare `package.json` / `AGENTS.md` never reaches it. The
  // gate above already required a known file extension, and loom renders a chip
  // only once the server confirms the file exists, so a bare span that clears
  // the gate resolves directly.
  return resolveMarkdownFileLinkMeta(inlineCodeFilePathCandidate(text) ?? text, cwd, baseDir);
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

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;

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

const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

function normalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

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

const SINGLE_LABEL_HOSTNAMES = new Set(["localhost"]);

const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;

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
