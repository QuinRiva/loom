import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * Prose-density signals for an MDX document: the mechanical signatures of a
 * paragraph too dense to read. Pure and import-light (only the unified chain, no
 * relative imports) because `evals/` imports this file by path to score model
 * output with the same code `planLint.ts` warns with.
 */

export const PARAGRAPH_WORDS = 100;
export const SENTENCE_WORDS = 30;

export interface ProseNode {
  type: string;
  name?: string | null;
  value?: string;
  children?: ProseNode[];
  position?: { start: { line: number } };
}

export interface ProseDensity {
  longParagraphs: { line: number; words: number }[];
  longSentences: { line: number; words: number }[];
  bracketedCitations: { line: number }[];
  ownLineSidenotes: { line: number }[];
}

// Frontmatter parsing matches the compile pipeline, so a `sign_document`
// manifest is not misread as headings/anchors the renderer never emits.
const parser = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm).use(remarkMdx);

export const parseProseTree = (source: string) => parser.parse(source) as ProseNode;

// Quoted text, headings (`######` source lines), tables and code are not the author's prose.
const SKIPPED = new Set(["blockquote", "heading", "table", "code", "yaml"]);
const ABBREVIATIONS = new Set(["e.g.", "i.e.", "vs.", "etc.", "cf."]);
const isSidenote = (node: ProseNode) => node.type.startsWith("mdxJsx") && node.name === "Sidenote";
const lineOf = (node: ProseNode) => node.position?.start.line ?? 0;
const countWords = (text: string) =>
  text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;

/** A paragraph's prose as one string, each inline code span one token, with the source line of every character. */
function paragraphText(paragraph: ProseNode) {
  let text = "";
  const lines: number[] = [];
  const append = (chunk: string, line: number) => {
    for (const char of chunk) {
      text += char;
      lines.push(line);
      if (char === "\n") line++;
    }
  };
  const walk = (node: ProseNode) => {
    if (isSidenote(node)) return;
    if (node.type === "text") append(node.value ?? "", lineOf(node));
    else if (node.type === "inlineCode" || node.type === "inlineMath") append("CODE", lineOf(node));
    else if (node.type === "break") append("\n", lineOf(node));
    else node.children?.forEach(walk);
  };
  paragraph.children?.forEach(walk);
  return { text, lines };
}

/** Sentences end at `.`, `!` or `?` (and any closing quote or bracket) before whitespace, bar a few abbreviations. */
function sentences(text: string, lines: number[]) {
  const result: { line: number; words: number }[] = [];
  let start = 0;
  const close = (end: number) => {
    const sentence = text.slice(start, end);
    const lead = sentence.search(/\S/);
    if (lead >= 0) result.push({ line: lines[start + lead]!, words: countWords(sentence) });
    start = end;
  };
  for (const match of text.matchAll(/[.!?]["'”’)\]]*(?=\s)/g)) {
    const end = match.index + match[0].length;
    const word = /\S*$/.exec(text.slice(start, end))![0].replace(/^[("'“‘[]+/, "");
    if (!ABBREVIATIONS.has(word.toLowerCase())) close(end);
  }
  close(text.length);
  return result;
}

/** `(` closing one text node, then a single inline code span, then `)` opening the next. */
function bracketedCitationLines(paragraph: ProseNode): number[] {
  const found: number[] = [];
  const walk = (node: ProseNode) => {
    if (isSidenote(node)) return;
    const children = node.children ?? [];
    children.forEach((child, index) => {
      if (
        child.type === "inlineCode" &&
        children[index - 1]?.type === "text" &&
        children[index - 1]!.value?.endsWith("(") &&
        children[index + 1]?.type === "text" &&
        children[index + 1]!.value?.startsWith(")")
      ) {
        found.push(lineOf(child));
      }
      walk(child);
    });
  };
  walk(paragraph);
  return found;
}

export function proseDensity(treeOrSource: string | ProseNode): ProseDensity {
  const tree = typeof treeOrSource === "string" ? parseProseTree(treeOrSource) : treeOrSource;
  const density: ProseDensity = {
    longParagraphs: [],
    longSentences: [],
    bracketedCitations: [],
    ownLineSidenotes: [],
  };
  const visit = (node: ProseNode) => {
    if (SKIPPED.has(node.type)) return;
    if (node.type === "mdxJsxFlowElement" && isSidenote(node)) {
      density.ownLineSidenotes.push({ line: lineOf(node) });
      return;
    }
    if (node.type !== "paragraph") {
      node.children?.forEach(visit);
      return;
    }
    // A one-line `<Sidenote>…</Sidenote>` on its own parses as a paragraph holding only the note.
    const children = node.children ?? [];
    if (
      children.some(isSidenote) &&
      children.every(
        (child) => isSidenote(child) || (child.type === "text" && !child.value?.trim()),
      )
    ) {
      density.ownLineSidenotes.push(
        ...children.filter(isSidenote).map((child) => ({ line: lineOf(child) })),
      );
      return;
    }
    const { text, lines } = paragraphText(node);
    const words = countWords(text);
    if (words > PARAGRAPH_WORDS) density.longParagraphs.push({ line: lineOf(node), words });
    density.longSentences.push(
      ...sentences(text, lines).filter((sentence) => sentence.words > SENTENCE_WORDS),
    );
    density.bracketedCitations.push(...bracketedCitationLines(node).map((line) => ({ line })));
  };
  visit(tree);
  return density;
}
