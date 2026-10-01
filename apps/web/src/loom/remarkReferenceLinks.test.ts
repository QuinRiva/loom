import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkReferenceLinks } from "./remarkReferenceLinks";

const rules = [
  { pattern: "\\b(?:PE|AIT)-\\d+\\b", url: "https://jira.example/browse/$0" },
  { pattern: "(?<![\\w/&])#([1-9]\\d{0,4})\\b", url: "https://gh.example/issues/$1" },
];

type Node = { type: string; url?: string; value?: string; children?: Node[] };

/** Every link in the transformed tree as `text -> url`. */
const links = (markdown: string) => {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkReferenceLinks, { rules });
  const tree = processor.runSync(processor.parse(markdown)) as Node;
  const out: string[] = [];
  const visit = (node: Node) => {
    if (node.type === "link") out.push(`${node.children?.[0]?.value} -> ${node.url}`);
    node.children?.forEach(visit);
  };
  visit(tree);
  return out;
};

describe("remarkReferenceLinks", () => {
  it("links ticket keys and #N in prose, substituting $0 and $1", () => {
    expect(links("numeric fields reject prose (AIT-7/165, PE-2368) — see #305.")).toEqual([
      "AIT-7 -> https://jira.example/browse/AIT-7",
      "PE-2368 -> https://jira.example/browse/PE-2368",
      "#305 -> https://gh.example/issues/305",
    ]);
  });

  it("leaves code spans, code blocks, authored links and colour-ish hashes alone", () => {
    expect(
      links(
        "`AIT-1` [PE-2](https://x.test) #ffffff #000000 a/#4\n\n# 12 heading\n\n```\nAIT-3 #9\n```",
      ),
    ).toEqual(["PE-2 -> https://x.test"]);
  });
});
