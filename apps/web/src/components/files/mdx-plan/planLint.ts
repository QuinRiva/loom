import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { z } from "zod";

import { attributeValue, type MdxAttrExpression } from "./mdxAttrs";
import { compilePlanMdx } from "./MdxPlanRenderer";
import { planBlockByTag } from "./registry";
import { sanitizeWireframeHtml } from "./sanitizeWireframeHtml";

/**
 * Agent-facing validator for MDX visual plans (`plans/<slug>/plan.mdx`) — checks
 * that a plan will render BEFORE it is handed to the user. Reuses the REAL
 * renderer modules (compile pipeline, block registry, zod schemas, wireframe
 * sanitiser) so it cannot drift from what the renderer accepts.
 *
 * Severity contract:
 *   - `error`   → the render would break or visibly degrade (whole-document
 *                 failure, per-block error card, invisible authored content).
 *   - `warning` → the render silently degrades (stripped HTML, ragged tables,
 *                 ignored props).
 *
 * Run headless via `apps/web/scripts/lint-plan.mjs` (jsdom + vite SSR module
 * loading); unit-tested under jsdom.
 */

export interface PlanLintFinding {
  severity: "error" | "warning";
  line?: number;
  column?: number;
  message: string;
}

/* ------------------------------- mdast types ------------------------------ */

interface Point {
  line: number;
  column: number;
}

interface MdastNode {
  type: string;
  name?: string;
  children?: MdastNode[];
  attributes?: JsxAttrNode[];
  position?: { start: Point };
}

interface JsxAttrNode {
  type: string;
  name?: string;
  value?: string | null | MdxAttrExpression;
  position?: { start: Point };
}

const mdxParser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

const at = (
  node: { position?: { start: Point } } | undefined,
): Pick<PlanLintFinding, "line" | "column"> =>
  node?.position ? { line: node.position.start.line, column: node.position.start.column } : {};

/* --------------------------- friendly MDX errors -------------------------- */

const HINTS: Array<[RegExp, string]> = [
  [
    /acorn|expression/i,
    "Hint: a raw `{` in prose starts a JS expression — escape it as `\\{`, and keep attribute expressions to literal JSON values.",
  ],
  [
    /end of file|before attribute name|before tag name|closing tag|before name/i,
    "Hint: check for an unclosed block tag or a stray `<` in prose — escape a literal `<` as `\\<` or `&lt;`.",
  ],
];

function mdxErrorFinding(cause: unknown): PlanLintFinding {
  const err = cause as Error & { line?: number; column?: number; reason?: string };
  const reason = err.reason ?? err.message ?? String(cause);
  const hint = HINTS.find(([test]) => test.test(reason))?.[1];
  return {
    severity: "error",
    ...(typeof err.line === "number" ? { line: err.line } : {}),
    ...(typeof err.column === "number" ? { column: err.column } : {}),
    message: hint ? `${reason}\n  ${hint}` : reason,
  };
}

/* ------------------------------ tag utilities ----------------------------- */

const KNOWN_TAGS = [...planBlockByTag.keys()];

function suggestTag(name: string): string | undefined {
  const lower = name.toLowerCase();
  return KNOWN_TAGS.find((tag) => {
    const t = tag.toLowerCase();
    return t === lower || t === `${lower}block` || t === `${lower}s` || `${t}s` === lower;
  });
}

/** Nearest JSX ancestor a slot/canvas tag must sit inside to render at all. */
const REQUIRED_PARENT: Record<string, string[]> = {
  Tab: ["TabsBlock"],
  Column: ["Columns"],
  Artboard: ["DesignBoard", "Section"],
  Section: ["DesignBoard"],
  Connector: ["DesignBoard", "Section"],
  Annotation: ["DesignBoard", "Section"],
};

/** Container tags whose JSX children outside this set render as phantom UI. */
const EXPECTED_CHILDREN: Record<string, string[]> = {
  TabsBlock: ["Tab"],
  Columns: ["Column"],
  DesignBoard: ["Artboard", "Section", "Connector", "Annotation"],
  Section: ["Artboard", "Connector", "Annotation"],
};

/* --------------------------------- linter --------------------------------- */

interface BoardScope {
  ids: Set<string>;
  refs: Array<{
    id: string;
    kind: "connector" | "annotation";
    hasFallback: boolean;
    node: MdastNode;
  }>;
}

export async function lintPlanSource(source: string): Promise<PlanLintFinding[]> {
  const findings: PlanLintFinding[] = [];
  let tree: MdastNode;
  try {
    tree = mdxParser.parse(source) as MdastNode;
  } catch (cause) {
    return [mdxErrorFinding(cause)]; // nothing else is checkable without a parse
  }

  const authoredIds = new Map<string, Point | undefined>();
  const reviewChoiceIds = new Map<string, Point | undefined>();
  const boardStack: BoardScope[] = [];
  const mermaidChecks: Array<{ source: string; node: MdastNode }> = [];

  const visit = (node: MdastNode, jsxAncestors: MdastNode[]) => {
    if (
      node.type === "mdxjsEsm" ||
      node.type === "mdxFlowExpression" ||
      node.type === "mdxTextExpression"
    ) {
      findings.push({
        severity: "error",
        ...at(node),
        message: `Disallowed MDX construct (${node.type}): imports/exports and raw {expressions} are rejected — the whole document fails to render. Escape a literal brace as \\{.`,
      });
    }

    const isJsx = node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
    const name = isJsx ? node.name : undefined;
    let pushedBoard = false;

    if (name && /^[A-Z]/.test(name)) {
      const entry = planBlockByTag.get(name);
      if (!entry) {
        const suggestion = suggestTag(name);
        findings.push({
          severity: "error",
          ...at(node),
          message:
            `Unknown tag <${name}> — it renders as an inline error card in the plan. ` +
            (suggestion
              ? `Did you mean <${suggestion}>?`
              : `Known tags: ${KNOWN_TAGS.join(", ")}.`),
        });
      } else {
        checkBlock(node, name, entry.block.schema, jsxAncestors);
      }
      if (name === "DesignBoard") {
        boardStack.push({ ids: new Set(), refs: [] });
        pushedBoard = true;
      }
    }

    const nextAncestors = isJsx && name ? [...jsxAncestors, node] : jsxAncestors;
    for (const child of node.children ?? []) visit(child, nextAncestors);

    if (pushedBoard) {
      const board = boardStack.pop()!;
      for (const ref of board.refs) {
        if (board.ids.has(ref.id)) continue;
        if (ref.kind === "connector") {
          findings.push({
            severity: "error",
            ...at(ref.node),
            message: `<Connector> references "${ref.id}" which is not an authored id on this board — the connector renders nothing. Board ids: ${[...board.ids].join(", ") || "(none)"}.`,
          });
        } else {
          findings.push({
            severity: ref.hasFallback ? "warning" : "error",
            ...at(ref.node),
            message:
              `<Annotation targetId="${ref.id}"> does not match an authored id on this board` +
              (ref.hasFallback
                ? " — it falls back to its x/y coordinates."
                : " — with no x/y fallback the note stays permanently invisible."),
          });
        }
      }
    }
  };

  const checkBlock = (
    node: MdastNode,
    tag: string,
    schema: z.ZodType,
    jsxAncestors: MdastNode[],
  ) => {
    // Resolve attributes to a props bag (the same resolution MDX applies).
    const props: Record<string, unknown> = {};
    let resolvable = true;
    for (const attr of node.attributes ?? []) {
      if (attr.type === "mdxJsxExpressionAttribute") {
        findings.push({
          severity: "error",
          ...at(attr),
          message: `<${tag}> uses a spread attribute ({...}) — not permitted in plans; write literal attributes instead.`,
        });
        resolvable = false;
        continue;
      }
      if (!attr.name) continue;
      try {
        props[attr.name] = attributeValue(attr as Parameters<typeof attributeValue>[0]);
      } catch (cause) {
        findings.push({
          severity: "error",
          ...at(attr),
          message: `<${tag}> attribute "${attr.name}": ${cause instanceof Error ? cause.message : String(cause)}`,
        });
        resolvable = false;
      }
    }
    if (!resolvable) return;

    // Schema validation — the exact zod schema the renderer applies.
    const result = schema.safeParse(props);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
        .join("; ");
      findings.push({
        severity: "error",
        ...at(node),
        message: `<${tag}> props failed validation (renders an in-document error card): ${issues}`,
      });
      return;
    }

    // Unknown props are silently stripped by zod — a typo'd prop dies unnoticed.
    if (schema instanceof z.ZodObject) {
      const known = new Set([...Object.keys(schema.shape), "id"]);
      for (const key of Object.keys(props)) {
        if (!known.has(key)) {
          findings.push({
            severity: "warning",
            ...at(node),
            message: `<${tag}> has unknown prop "${key}" — the renderer silently ignores it. Known props: ${Object.keys(schema.shape).join(", ")}.`,
          });
        }
      }
    }

    // Nesting rules — a slot/canvas tag outside its container renders wrong or not at all.
    const requiredParents = REQUIRED_PARENT[tag];
    const parentName = jsxAncestors.at(-1)?.name;
    if (requiredParents && (!parentName || !requiredParents.includes(parentName))) {
      findings.push({
        severity: "error",
        ...at(node),
        message: `<${tag}> must be a direct child of ${requiredParents.map((p) => `<${p}>`).join(" or ")}${parentName ? ` (found inside <${parentName}>)` : ""}.`,
      });
    }
    const expectedChildren = EXPECTED_CHILDREN[tag];
    if (expectedChildren) {
      // Inline-authored blocks arrive wrapped in a paragraph as text elements.
      const jsxChildren = (node.children ?? []).flatMap((child) =>
        child.type === "paragraph"
          ? (child.children ?? []).filter((c) => c.type === "mdxJsxTextElement")
          : [child],
      );
      for (const child of jsxChildren) {
        if (
          child.type.startsWith("mdxJsx") &&
          child.name &&
          /^[A-Z]/.test(child.name) &&
          !expectedChildren.includes(child.name)
        ) {
          findings.push({
            severity: "warning",
            ...at(child),
            message: `<${child.name}> is not a ${expectedChildren.map((c) => `<${c}>`).join("/")} — direct children of <${tag}> outside that set render as broken phantom UI.`,
          });
        }
      }
    }

    // Authored id bookkeeping (duplicates hijack annotation anchors + canvas targets).
    const id = typeof props.id === "string" && props.id ? props.id : undefined;
    if (id) {
      if (authoredIds.has(id)) {
        findings.push({
          severity: "error",
          ...at(node),
          message: `Duplicate block id "${id}" (first used at line ${authoredIds.get(id)?.line ?? "?"}) — annotation anchors and canvas targets resolve to the first match only.`,
        });
      } else {
        authoredIds.set(id, node.position?.start);
      }
      boardStack.at(-1)?.ids.add(id);
    }

    // Per-block content checks.
    const data = result.data as Record<string, unknown>;
    // `<ReviewChoice itemId>` must be unique per file: the id is the aggregation
    // key for its deterministic `mdx-review:` comment, so a duplicate silently
    // collapses two widgets onto one decision. The registry-derived checks cannot
    // infer this semantic rule (it is the one lint addition for these blocks).
    if (tag === "ReviewChoice" && typeof data.itemId === "string" && data.itemId) {
      const first = reviewChoiceIds.get(data.itemId);
      if (reviewChoiceIds.has(data.itemId)) {
        findings.push({
          severity: "error",
          ...at(node),
          message: `Duplicate <ReviewChoice itemId="${data.itemId}"> (first used at line ${first?.line ?? "?"}) — both widgets collapse onto one review comment; give each item a unique itemId.`,
        });
      } else {
        reviewChoiceIds.set(data.itemId, node.position?.start);
      }
    }
    const board = boardStack.at(-1);
    if (tag === "Connector" && board) {
      for (const key of ["from", "to"] as const) {
        if (typeof data[key] === "string") {
          board.refs.push({ id: data[key] as string, kind: "connector", hasFallback: false, node });
        }
      }
    }
    if (tag === "Annotation" && board && typeof data.targetId === "string") {
      board.refs.push({
        id: data.targetId,
        kind: "annotation",
        hasFallback: typeof data.x === "number" && typeof data.y === "number",
        node,
      });
    }
    if (tag === "Diagram") {
      const nodes = (data.nodes as Array<{ id: string }> | undefined) ?? [];
      const nodeIds = new Set(nodes.map((n) => n.id));
      if (nodeIds.size < nodes.length) {
        findings.push({
          severity: "error",
          ...at(node),
          message: `<Diagram> has duplicate node ids.`,
        });
      }
      for (const edge of (data.edges as Array<{ from: string; to: string }> | undefined) ?? []) {
        for (const end of [edge.from, edge.to]) {
          if (!nodeIds.has(end)) {
            findings.push({
              severity: "error",
              ...at(node),
              message: `<Diagram> edge endpoint "${end}" does not match any node id — the edge is not drawn. Node ids: ${[...nodeIds].join(", ") || "(none)"}.`,
            });
          }
        }
      }
    }
    if (tag === "Json" && typeof data.json === "string") {
      try {
        JSON.parse(data.json);
      } catch (cause) {
        findings.push({
          severity: "error",
          ...at(node),
          message: `<Json> "json" is not valid JSON (renders an error card): ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }
    if (tag === "OpenApi" && typeof data.spec === "string") {
      try {
        JSON.parse(data.spec);
      } catch (cause) {
        const looksLikeYaml = /^\s*(openapi|swagger)\s*:/m.test(data.spec);
        findings.push({
          severity: "error",
          ...at(node),
          message: looksLikeYaml
            ? `<OpenApi> "spec" looks like YAML — the renderer parses JSON only. Convert the spec to JSON.`
            : `<OpenApi> "spec" is not valid JSON (renders an error card): ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }
    if (tag === "Mermaid" && typeof data.source === "string") {
      if (!data.source.trim()) {
        findings.push({
          severity: "warning",
          ...at(node),
          message: `<Mermaid> has an empty source — it renders an "Empty diagram" note.`,
        });
      } else {
        mermaidChecks.push({ source: data.source, node });
      }
    }
    if (tag === "Table") {
      const columns = (data.columns as string[] | undefined) ?? [];
      const rows = (data.rows as string[][] | undefined) ?? [];
      const ragged = rows.flatMap((row, index) =>
        row.length === columns.length ? [] : [index + 1],
      );
      if (columns.length && ragged.length) {
        findings.push({
          severity: "warning",
          ...at(node),
          message: `<Table> row${ragged.length > 1 ? "s" : ""} ${ragged.join(", ")} ${ragged.length > 1 ? "do" : "does"} not have ${columns.length} cells to match the columns — the grid renders ragged.`,
        });
      }
    }
    const htmlTags = new Set(["Screen", "Design", "Artboard"]);
    if (
      htmlTags.has(tag) &&
      typeof data.html === "string" &&
      data.html &&
      typeof DOMParser !== "undefined"
    ) {
      const design = tag === "Design" || data.fidelity === "design";
      const stripped: string[] = [];
      sanitizeWireframeHtml(data.html, {
        preserveThemeClasses: design,
        onStrip: (message) => stripped.push(message),
      });
      for (const message of [...new Set(stripped)]) {
        findings.push({
          severity: "warning",
          ...at(node),
          message: `<${tag}> html: sanitiser will silently strip — ${message}`,
        });
      }
    }
  };

  visit(tree, []);

  // Mermaid sources must pass the real mermaid parser (the renderer shows a
  // per-block error card otherwise). Degrades to a warning without a DOM.
  if (mermaidChecks.length) {
    if (typeof document === "undefined") {
      findings.push({
        severity: "warning",
        message: "Mermaid sources were not validated (no DOM available in this environment).",
      });
    } else {
      const mermaid = (await import("mermaid")).default;
      for (const { source: mermaidSource, node } of mermaidChecks) {
        try {
          await mermaid.parse(mermaidSource);
        } catch (cause) {
          const message = (cause instanceof Error ? cause.message : String(cause))
            .trim()
            .slice(0, 400);
          findings.push({
            severity: "error",
            ...at(node),
            message: `<Mermaid> source failed to parse (renders an error card):\n  ${message.replace(/\n/g, "\n  ")}`,
          });
        }
      }
    }
  }

  // Authoritative compile gate — the exact pipeline the renderer runs. Catches
  // anything the AST passes above miss; skipped when they already found errors
  // (the compile failure would just repeat them without a position).
  if (!findings.some((finding) => finding.severity === "error")) {
    try {
      await compilePlanMdx(source);
    } catch (cause) {
      findings.push(mdxErrorFinding(cause));
    }
  }

  return findings.sort(
    (a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || (a.column ?? 0) - (b.column ?? 0),
  );
}

/** Render findings as terse `file:line:col severity: message` lines + a summary. */
export function formatFindings(findings: PlanLintFinding[], file: string): string {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  if (!findings.length) return `${file}: OK — no findings.`;
  const lines = findings.map(
    (finding) =>
      `${file}${finding.line !== undefined ? `:${finding.line}${finding.column !== undefined ? `:${finding.column}` : ""}` : ""} ${finding.severity}: ${finding.message}`,
  );
  return [...lines, "", `${errors} error(s), ${warnings} warning(s)`].join("\n");
}
