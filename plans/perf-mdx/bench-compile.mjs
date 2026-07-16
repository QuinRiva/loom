// Measures the compilePlanMdx path (evaluate = compile + eval) per doc size, in Node.
// Replicates MdxPlanRenderer.evaluateOptions: remarkGfm + the two guard walks.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const require = (await import("node:module")).createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { evaluate } = await import(require.resolve("@mdx-js/mdx"));
const remarkGfm = (await import(require.resolve("remark-gfm"))).default;
const runtime = await import(require.resolve("react/jsx-runtime"));

const DISALLOWED = new Set(["mdxjsEsm", "mdxFlowExpression", "mdxTextExpression"]);
function remarkRejectCodeEscapes() {
  return (tree) => {
    const walk = (node) => {
      if (DISALLOWED.has(node.type)) throw new Error(`Disallowed: ${node.type}`);
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
const JSX = new Set(["mdxJsxFlowElement", "mdxJsxTextElement"]);
function remarkUnknownBlockFallback() {
  return (tree) => {
    const walk = (node) => {
      for (const child of node.children ?? []) walk(child);
      if (JSX.has(node.type) && node.name && /^[A-Z]/.test(node.name)) {
        // (real code checks registry membership; our fixture uses only known tags)
      }
    };
    walk(tree);
  };
}

const options = {
  ...runtime,
  remarkPlugins: [remarkGfm, remarkRejectCodeEscapes, remarkUnknownBlockFallback],
  development: false,
};

const sizes = process.argv.slice(2);
console.log("size_MB\tbytes\tcompile+eval_ms (median of 5)");
for (const mb of sizes) {
  const src = readFileSync(new URL(`doc-${mb}.mdx`, import.meta.url), "utf8");
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await evaluate(src, options);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[2];
  console.log(`${mb}\t${src.length}\t${median.toFixed(0)}\t[${times.map((t) => t.toFixed(0)).join(", ")}]`);
}
