/**
 * Project reference links (`.t3code/links.json`): ticket keys and PR/issue
 * numbers in agent prose render as links. Rules arrive per project on
 * `ServerConfig.referenceLinks`; every renderer (chat markdown, MDX documents,
 * plain sidebar text) shares this matcher so they agree on what links where.
 */

export interface ReferenceLinkRule {
  readonly pattern: string;
  readonly url: string;
}

export interface ReferenceLinker {
  readonly regex: RegExp;
  /** Per rule: its url template and the index of its wrapping group in `regex`. */
  readonly rules: ReadonlyArray<{ readonly url: string; readonly group: number }>;
}

/** `start` is the segment's offset in the source text (a stable render key). */
export type ReferenceLinkSegment = {
  readonly text: string;
  readonly start: number;
  readonly url?: string;
};

const compiled = new WeakMap<ReadonlyArray<ReferenceLinkRule>, ReferenceLinker | null>();

/**
 * One alternation regex for all rules, so a text is scanned once and the
 * earliest match wins, with ties going to the first rule. Memoised on the rules
 * array (stable per server config snapshot), so callers may compile on every
 * render.
 * Invalid patterns are dropped.
 */
export function compileReferenceLinks(
  rules: ReadonlyArray<ReferenceLinkRule> | undefined,
): ReferenceLinker | null {
  if (!rules?.length) return null;
  const cached = compiled.get(rules);
  if (cached !== undefined) return cached;
  const sources: string[] = [];
  const entries: Array<{ url: string; group: number }> = [];
  let group = 1;
  for (const rule of rules) {
    try {
      // Capture-group count of the pattern: an empty-alternative match yields one slot per group.
      const groups = new RegExp(`${rule.pattern}|`).exec("")!.length - 1;
      sources.push(`(${rule.pattern})`);
      entries.push({ url: rule.url, group });
      group += groups + 1;
    } catch {
      // Invalid pattern: skip the rule rather than disabling the project's others.
    }
  }
  const linker = sources.length
    ? { regex: new RegExp(sources.join("|"), "g"), rules: entries }
    : null;
  compiled.set(rules, linker);
  return linker;
}

/** Split plain text into literal and linked segments; null when nothing matches. */
export function splitReferenceLinks(
  text: string,
  linker: ReferenceLinker,
): ReferenceLinkSegment[] | null {
  const segments: ReferenceLinkSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(linker.regex)) {
    const rule = linker.rules.find((entry) => match[entry.group] !== undefined);
    if (!rule || match[0].length === 0) continue;
    if (match.index > cursor)
      segments.push({ text: text.slice(cursor, match.index), start: cursor });
    const url = rule.url.replace(/\$(\d+)/g, (_, n: string) => match[rule.group + Number(n)] ?? "");
    segments.push({ text: match[0], start: match.index, url });
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return null;
  if (cursor < text.length) segments.push({ text: text.slice(cursor), start: cursor });
  return segments;
}
