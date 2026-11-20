/**
 * loom: draws authorship, and code queries' marks, on rows the diff viewer already rendered
 * (plans/diff-author-query/plan.mdx §4). The viewer is virtualised with fixed row heights and has no
 * per-line decoration option, so its post-render hook stamps attributes on the added lines it drew
 * and a label into each hunk's separator row; static CSS paints them. Nothing adds or resizes a row.
 */
import type { FileDiffMetadata } from "@pierre/diffs";

import { resolveFileDiffPath } from "../../lib/diffRendering";
import {
  AUTHOR_COLOURS,
  NEUTRAL_AUTHOR_COLOUR,
  type AuthorGroup,
  type Authorship,
} from "./authorship";
import { type CodeQuestion, lineText, marks } from "./codeQueryMarks";

export interface AuthorshipView {
  readonly authorship: Authorship;
  /** The group the diff is narrowed to; other groups' lines are dimmed. */
  readonly filter: string | null;
  /** Live code questions; a line is marked while one of them `marks` it. */
  readonly questions: ReadonlyArray<CodeQuestion>;
  /** The whole-branch answer, unnarrowed: a mark holds on a line any comparison shows unchanged. */
  readonly branch: Authorship;
}

const HUNK_LABEL = "data-loom-hunk-authors";
const authorMark = (group: AuthorGroup) =>
  group.slot !== null ? String(group.slot) : group.kind === "uncommitted" ? "u" : "n";

const label = (doc: Document, owners: ReturnType<Authorship["between"]>) => {
  const span = doc.createElement("span");
  span.setAttribute(HUNK_LABEL, "");
  for (const { group, sha } of owners) {
    const entry = doc.createElement("span");
    entry.setAttribute("data-loom-author", authorMark(group));
    entry.textContent = sha ? `${group.label} · ${sha.slice(0, 7)}` : group.label;
    entry.title = entry.textContent;
    span.append(entry);
  }
  return span;
};

function stamp(node: HTMLElement, diff: FileDiffMetadata, view: AuthorshipView | null) {
  const root = node.shadowRoot;
  if (!root) return;
  for (const old of root.querySelectorAll(`[${HUNK_LABEL}]`)) old.remove();
  const path = resolveFileDiffPath(diff);
  // Added lines carry their new-side number: `data-line` on the code row, `data-column-number`
  // on its gutter cell.
  for (const row of root.querySelectorAll<HTMLElement>('[data-line-type="change-addition"]')) {
    const line = Number(row.dataset.line ?? row.dataset.columnNumber);
    const owner = view?.authorship.at(path, line) ?? null;
    if (owner === null) {
      row.removeAttribute("data-loom-author");
      row.removeAttribute("data-loom-dim");
      continue;
    }
    row.setAttribute("data-loom-author", authorMark(owner.group));
    row.toggleAttribute("data-loom-dim", view!.filter !== null && view!.filter !== owner.group.key);
  }
  const split = root.querySelector("[data-additions]") !== null;
  // Marks: added lines, and unchanged ones (new side only) while a question is on this file or
  // a mark from one is still drawn.
  const asked = view?.questions.filter((question) => question.filePath === path) ?? [];
  const markable =
    asked.length > 0 || root.querySelector("[data-loom-asked]") !== null
      ? ',[data-line-type^="context"]'
      : "";
  for (const row of root.querySelectorAll<HTMLElement>(
    split
      ? `[data-additions] :is([data-line-type="change-addition"]${markable})`
      : `[data-line-type="change-addition"]${markable}`,
  )) {
    const line = Number(row.dataset.line ?? row.dataset.columnNumber);
    const owner = view?.branch.at(path, line) ?? null;
    row.toggleAttribute(
      "data-loom-asked",
      asked.some((question) =>
        marks(
          question,
          path,
          line,
          owner,
          question.commitChanged === "file" ? lineText(diff, line) : undefined,
        ),
      ),
    );
  }
  if (view === null) return;
  // A separator above hunk N carries its expand index, once per column. Unified draws the
  // gutter's copy across the row; split draws the new side's code-column copy over that half.
  const separators = new Map<string, Element>();
  for (const separator of root.querySelectorAll<HTMLElement>(
    split
      ? "[data-additions] [data-content] [data-separator][data-expand-index]:not([data-separator-last])"
      : "[data-gutter] [data-separator][data-expand-index]:not([data-separator-last])",
  )) {
    const target = separator.querySelector(
      split ? "[data-separator-wrapper]" : "[data-separator-content]",
    );
    if (target) separators.set(separator.dataset.expandIndex!, target);
  }
  for (const [index, separator] of separators) {
    const hunk = diff.hunks[Number(index)];
    if (!hunk) continue;
    const owners = view.authorship.between(
      path,
      hunk.additionStart,
      hunk.additionStart + hunk.additionCount - 1,
    );
    if (owners.length > 0) separator.append(label(node.ownerDocument, owners));
  }
}

/**
 * The viewer's post-render hook plus `update`, which restamps every mounted file when the
 * authorship or filter changes (the viewer does not re-render for that).
 */
export function createAuthorshipStamps() {
  const mounted = new Map<HTMLElement, FileDiffMetadata>();
  let view: AuthorshipView | null = null;
  return {
    /** `diff` is the item's diff; undefined for a plain file, which has no authors. */
    onPostRender(node: HTMLElement, phase: string, diff: FileDiffMetadata | undefined) {
      if (phase === "unmount" || diff === undefined) {
        mounted.delete(node);
        return;
      }
      mounted.set(node, diff);
      stamp(node, diff, view);
    },
    update(next: AuthorshipView | null) {
      if (
        next?.authorship === view?.authorship &&
        next?.filter === view?.filter &&
        next?.questions === view?.questions &&
        next?.branch === view?.branch
      )
        return;
      view = next;
      for (const [node, diff] of mounted) stamp(node, diff, view);
    },
  };
}

const slotColours = [...AUTHOR_COLOURS.entries()]
  .map(([slot, colour]) => `[data-loom-author="${slot}"] { --loom-author: ${colour}; }`)
  .join("\n");

/** Appended to the viewer's CSS while authorship is on; it lives in each file's shadow root. */
export const AUTHORSHIP_CSS = `
${slotColours}
[data-loom-author="n"] { --loom-author: ${NEUTRAL_AUTHOR_COLOUR}; }
[data-loom-author="u"] { --loom-author: ${NEUTRAL_AUTHOR_COLOUR}; }
/* The edge: the viewer's own added-line bar, recoloured to the author; dashed when uncommitted. */
[data-column-number][data-loom-author]::before {
  background-color: var(--loom-author) !important;
}
[data-column-number][data-loom-author="u"]::before {
  background-color: transparent !important;
  background-image: repeating-linear-gradient(
    to bottom, var(--loom-author) 0 3px, transparent 3px 6px
  ) !important;
  background-size: auto !important;
}
[data-loom-dim] { opacity: 0.35; }
/* A question was asked about the line: a mark beside its author edge. */
[data-column-number][data-loom-asked]::after {
  content: "?";
  position: absolute;
  top: 0;
  left: 6px;
  font-family: var(--font-sans);
  font-weight: 700;
  color: var(--color-primary);
}
[${HUNK_LABEL}] {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
  gap: 10px;
  margin-inline-start: auto;
  padding-inline-end: 8px;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-sans);
  font-size: 11px;
  white-space: nowrap;
}
[${HUNK_LABEL}] > [data-loom-author] {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--loom-author);
}
[${HUNK_LABEL}] > [data-loom-author]::before { content: "● "; }
[${HUNK_LABEL}] > [data-loom-author="u"]::before { content: "◌ "; }
`;
