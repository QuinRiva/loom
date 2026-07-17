import * as NodeFS from "node:fs";
const require = (await import("node:module")).createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { evaluate } = await import(require.resolve("@mdx-js/mdx"));
const remarkGfm = (await import(require.resolve("remark-gfm"))).default;
const runtime = await import(require.resolve("react/jsx-runtime"));
const opts = { ...runtime, remarkPlugins: [remarkGfm], development: false };
const CAP = 1024*1024;
const full = NodeFS.readFileSync(new URL("doc-1.mdx", import.meta.url), "utf8");
const buf = Buffer.from(full, "utf8");
console.log("full bytes", buf.length, "> cap", buf.length > CAP);
const truncated = buf.subarray(0, CAP).toString("utf8"); // server slices bytes then decodes
try {
  await evaluate(truncated, opts);
  console.log("TRUNCATED COMPILED OK (unexpected)");
} catch (e) {
  console.log("TRUNCATED COMPILE FAILED (expected):");
  console.log("  " + String(e.message).slice(0,160).replace(/\n/g," "));
}
