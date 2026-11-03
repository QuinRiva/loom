import {
  parseProseTree,
  proseDensity,
  type ProseNode,
} from "../../apps/web/src/components/files/mdx-plan/proseDensity.ts";

// The same prose the lint reads: paragraphs outside quotes, headings, tables, code and notes.
const SKIPPED = new Set(["blockquote", "heading", "table", "code", "yaml"]);
const isSidenote = (node: ProseNode) => node.type.startsWith("mdxJsx") && node.name === "Sidenote";
const countWords = (text: string) =>
  text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;

/** Word count of every sentence in the document's prose; inline code is one word. */
function sentenceLengths(tree: ProseNode): number[] {
  const text = (node: ProseNode): string =>
    isSidenote(node)
      ? " "
      : node.type === "text"
        ? (node.value ?? "")
        : node.type === "inlineCode"
          ? "CODE"
          : (node.children ?? []).map(text).join("");
  const visit = (node: ProseNode): number[] =>
    SKIPPED.has(node.type) || isSidenote(node)
      ? []
      : node.type === "paragraph"
        ? text(node)
            .replace(/\b(e\.g|i\.e|vs|etc|cf)\./gi, "$1")
            .split(/(?<=[.!?]["'”’)\]]*)\s+/)
            .map(countWords)
            .filter((words) => words > 0)
        : (node.children ?? []).flatMap(visit);
  return visit(tree);
}

// Shape D's three parts. The verdict is the first prose line, bold-led and naming the outcome.
const firstProseLine = (mdx: string) =>
  mdx
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !/^(#|<|\/>|---|```)/.test(line)) ?? "";
const hasVerdict = (mdx: string) =>
  /^\*\*Verdict\b/im.test(mdx) ||
  /^\*\*[^*\n]*\b(verdict|wrong|fail(s|ed)?|correct)\b[^*\n]*\*\*/i.test(firstProseLine(mdx));
const labelledParagraphs = (mdx: string) =>
  mdx.match(/^\*\*[^*\n]{2,80}[.:?]\*\*\s+\S/gm)?.length ?? 0;

export function grade(mdx: string) {
  const tree = parseProseTree(mdx);
  const density = proseDensity(tree);
  const sentences = sentenceLengths(tree);
  return {
    words: countWords(mdx.replace(/<[^>]*>/g, " ")),
    sentences: sentences.length,
    meanSentence: sentences.length
      ? sentences.reduce((sum, words) => sum + words, 0) / sentences.length
      : 0,
    longSentences: density.longSentences.length,
    longParagraphs: density.longParagraphs.length,
    bracketedCitations: density.bracketedCitations.length,
    sidenotes: mdx.match(/<Sidenote\b/g)?.length ?? 0,
    emDashes: mdx.match(/—/g)?.length ?? 0,
    verdict: hasVerdict(mdx),
    table: /<Table\b/.test(mdx),
    labelled: labelledParagraphs(mdx) >= 2,
  };
}

export type Grade = ReturnType<typeof grade>;
