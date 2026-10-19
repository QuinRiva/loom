import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { z } from "zod";

import type { PlanQuestion } from "./blocks/questionForm";
import { rowParts, type TableData } from "./blocks/table";
import { assignHeadingAnchors } from "./headingAnchors";
import { attributeValue, type MdxAttrExpression } from "./mdxAttrs";
import { compilePlanMdx } from "./mdxCompileOptions";
import { ALLOWED_HTML_TAGS, rawHtmlTagMessage } from "./planBlockTags";
import { planBlockByTag } from "./registry";
import { sanitizeWireframeHtml } from "./sanitizeWireframeHtml";
import { toneSchema } from "./tones";

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

// Mdast types.

interface Point {
  line: number;
  column: number;
  offset?: number;
}

interface MdastNode {
  type: string;
  name?: string;
  value?: string;
  children?: MdastNode[];
  attributes?: JsxAttrNode[];
  position?: { start: Point; end?: Point };
}

interface JsxAttrNode {
  type: string;
  name?: string;
  value?: string | null | MdxAttrExpression;
  position?: { start: Point };
}

// Frontmatter parsing matches the compile pipeline, so a `sign_document`
// manifest is not misread as headings/anchors the renderer never emits.
const mdxParser = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm).use(remarkMdx);

/**
 * Source-size budget. The `.mdx` preview reads up to an 8 MiB transport ceiling
 * ({@link PROJECT_READ_FILE_PLAN_MAX_BYTES} on the server); a source above it is
 * truncated before the renderer and fails to open, so it is an error. Approaching
 * the ceiling keeps compile multi-second even off the main thread, so warn early.
 */
const PLAN_SIZE_WARN_BYTES = 6 * 1024 * 1024;
const PLAN_SIZE_ERROR_BYTES = 8 * 1024 * 1024;

export function planSizeFinding(source: string): PlanLintFinding | null {
  const byteLength = new TextEncoder().encode(source).length;
  if (byteLength <= PLAN_SIZE_WARN_BYTES) return null;
  const mb = (byteLength / 1024 / 1024).toFixed(1);
  if (byteLength > PLAN_SIZE_ERROR_BYTES) {
    return {
      severity: "error",
      message: `Plan source is ${mb} MB, above the 8 MiB transport ceiling — the preview would truncate it before the renderer and fail to open. Split the document or trim embedded evidence.`,
    };
  }
  return {
    severity: "warning",
    message: `Plan source is ${mb} MB, approaching the 8 MiB transport ceiling — compile stays multi-second even off the main thread. Consider splitting the document or trimming embedded evidence.`,
  };
}

/**
 * The reader brief `skills/mdx-doc-core/references/document-quality.md` §1 asks
 * every plan, recap and explainer to declare in frontmatter. Parsed as YAML
 * because `sign_document` appends `manager_sessions:` to the same block.
 */
const hasReaderBrief = Schema.is(
  Schema.Struct({
    reader: Schema.Struct({
      who: Schema.NonEmptyString,
      knows: Schema.NonEmptyString,
      after_first_screen: Schema.NonEmptyString,
    }),
  }),
);
const decodeFrontmatter = Schema.decodeUnknownOption(fromYaml(Schema.Unknown));

// Promote to an error once the exemplar document set lands (brief author's request).
function readerBriefFinding(tree: MdastNode): PlanLintFinding | null {
  const yaml = tree.children?.find((node) => node.type === "yaml");
  if (hasReaderBrief(Option.getOrUndefined(decodeFrontmatter(yaml?.value ?? "")))) return null;
  return {
    severity: "warning",
    ...at(yaml),
    message:
      "No reader brief in frontmatter — declare `reader:` with non-empty `who`, `knows` and `after_first_screen` (see skills/mdx-doc-core/references/document-quality.md §1) so the document is written for a named reader.",
  };
}

// Rendered-text defects (post-render).

/** Literal escape sequences (`\u2014`) and UTF-8-read-as-latin-1 mojibake
 * (`â€”`, `Â `, `\uFFFD`) that reached the page as *visible text*. */
const RENDERED_TEXT_DEFECTS: Array<[RegExp, string]> = [
  [/\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/g, "a literal escape sequence"],
  [
    /\uFFFD|[\u00C2\u00C3\u00E2][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]/g,
    "mojibake (UTF-8 bytes decoded as latin-1)",
  ],
];

const HTML_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  amp: "&",
  "#39": "'",
  nbsp: "\u00A0",
};

/**
 * Findings for text defects that only exist in the RENDERED output: a build
 * script that wrote `\u2014` into a caption, or a re-encoded file that turned
 * an em dash into `â€”`. The document is structurally perfect, so every other
 * pass is blind to them — only reading the rendered page catches them, which is
 * exactly the expensive manual check this replaces.
 *
 * `<pre>`/`<code>` content is exempt: an escape sequence inside a code sample is
 * usually the subject, not a defect.
 */
export function renderedTextFindings(html: string): PlanLintFinding[] {
  const text = html
    .replace(/<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(lt|gt|quot|amp|#39|nbsp);/g, (match, name: string) => HTML_ENTITIES[name] ?? match);

  return RENDERED_TEXT_DEFECTS.flatMap(([pattern, label]) => {
    const matches = [...text.matchAll(pattern)];
    if (!matches.length) return [];
    const { 0: sample, index } = matches[0]!;
    return [
      {
        severity: "error" as const,
        message: `Rendered text contains ${label} (\`${sample}\`${matches.length > 1 ? `, ${matches.length} occurrences` : ""}) — it displays verbatim to the reader. Context: …${text
          .slice(Math.max(0, index - 60), index + 60)
          .replace(/\s+/g, " ")
          .trim()}…`,
      },
    ];
  });
}

const at = (
  node: { position?: { start: Point } } | undefined,
): Pick<PlanLintFinding, "line" | "column"> =>
  node?.position ? { line: node.position.start.line, column: node.position.start.column } : {};

// Friendly MDX errors.

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

// Tag utilities.

/**
 * zod reports a failed union as one `invalid_union` "Invalid input" issue at the
 * union's path. Descend into its branches and keep the one whose failure goes
 * deepest — the shape the author was attempting (a cell object with a bad `tone`
 * beats "expected string") — so the message names the real problem. Branches
 * tied at that depth are all kept.
 */
function specificIssues(issue: z.ZodIssue): z.ZodIssue[] {
  if (issue.code !== "invalid_union") return [issue];
  const branches = issue.unionErrors.map((error) => error.issues.flatMap(specificIssues));
  const depth = (issues: z.ZodIssue[]) => Math.max(...issues.map((i) => i.path.length));
  const deepest = Math.max(...branches.map(depth));
  return branches.filter((branch) => depth(branch) === deepest).flat();
}

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
  // vocabulary v2: steps
  Step: ["Steps"],
  Artboard: ["DesignBoard", "Section"],
  Section: ["DesignBoard"],
  Connector: ["DesignBoard", "Section"],
  Annotation: ["DesignBoard", "Section"],
};

/** Container tags whose JSX children outside this set render as phantom UI. */
const EXPECTED_CHILDREN: Record<string, string[]> = {
  TabsBlock: ["Tab"],
  // vocabulary v2: steps
  Steps: ["Step"],
  DesignBoard: ["Artboard", "Section", "Connector", "Annotation"],
  Section: ["Artboard", "Connector", "Annotation"],
};

// Linter.

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
  const sizeFinding = planSizeFinding(source);
  if (sizeFinding) {
    // A source above the transport ceiling would be truncated before the
    // renderer, so it cannot be viewed regardless of its contents — fail fast
    // rather than parse + compile a multi-MB doc that is doomed anyway.
    if (sizeFinding.severity === "error") return [sizeFinding];
    findings.push(sizeFinding);
  }
  let tree: MdastNode;
  try {
    tree = mdxParser.parse(source) as MdastNode;
  } catch (cause) {
    return [mdxErrorFinding(cause)]; // nothing else is checkable without a parse
  }

  // The heading slugs a question's `refs[].anchor` may name — derived by the same
  // function the compile pipeline and the peek use, on the same tree, so "this
  // anchor is valid" and "this is the section it opens" cannot disagree.
  const headingSlugs = new Set(Object.keys(assignHeadingAnchors(tree)));

  const readerFinding = readerBriefFinding(tree);
  if (readerFinding) findings.push(readerFinding);

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

    // vocabulary v2: raw HTML guard — mirrors `remarkUnknownBlockFallback`.
    if (name && /^[a-z]/.test(name)) {
      if (!ALLOWED_HTML_TAGS.has(name)) {
        findings.push({ severity: "error", ...at(node), message: rawHtmlTagMessage(name) });
      } else if (node.attributes?.length) {
        findings.push({
          severity: "warning",
          ...at(node),
          message: `<${name}> attributes are stripped — raw HTML renders unstyled. For a pill use <Badge tone>.`,
        });
      }
    }

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
        .flatMap(specificIssues)
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
    // Block children (capitalised JSX); inline-authored blocks arrive wrapped
    // in a paragraph as text elements.
    const blockChildren = (node.children ?? [])
      .flatMap((child) =>
        child.type === "paragraph"
          ? (child.children ?? []).filter((c) => c.type === "mdxJsxTextElement")
          : [child],
      )
      .filter((child) => child.type.startsWith("mdxJsx") && /^[A-Z]/.test(child.name ?? ""));
    const expectedChildren = EXPECTED_CHILDREN[tag];
    if (expectedChildren) {
      for (const child of blockChildren) {
        if (!expectedChildren.includes(child.name!)) {
          findings.push({
            severity: "warning",
            ...at(child),
            message: `<${child.name}> is not a ${expectedChildren.map((c) => `<${c}>`).join("/")} — direct children of <${tag}> outside that set render as broken phantom UI.`,
          });
        }
      }
    }

    // vocabulary v2: Columns — a direct child is a <Column> slot or a bare block
    // (cards are columns); mixing the two renders a labelled slot beside a bare
    // block at different heights.
    if (tag === "Columns") {
      const slots = blockChildren.filter((child) => child.name === "Column").length;
      if (slots && slots < blockChildren.length) {
        findings.push({
          severity: "warning",
          ...at(node),
          message: `<Columns> mixes <Column> slots with bare blocks — they render at different heights. Use <Column> for every side, or none (a row of <Card>s needs no wrappers).`,
        });
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
    // A question's `refs[].anchor` names a heading slug. An anchor that resolves
    // to nothing is a dead chip, so it fails the authoring gate: heading text is
    // the slug, and editing a heading is exactly how a ref silently rots.
    if (tag === "QuestionForm" || tag === "VisualQuestions") {
      for (const question of (data.questions as PlanQuestion[] | undefined) ?? []) {
        for (const ref of question.refs ?? []) {
          if (headingSlugs.has(ref.anchor)) continue;
          findings.push({
            severity: "error",
            ...at(node),
            message: `Question "${question.id}" references anchor "${ref.anchor}", which is not a heading in this document — the chip would open an empty peek. An anchor is a heading slug ("## Delivery order" → "delivery-order"); this document has: ${[...headingSlugs].join(", ") || "(none)"}.`,
          });
        }
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
      // vocabulary v2: mermaid — a `tone-*` node class or edge colour
      // (`linkStyle N stroke:tone-risk`) outside the palette (and not the
      // author's own `classDef`) silently styles nothing.
      const defined = new Set(
        [...data.source.matchAll(/^\s*classDef\s+([\w,-]+)/gm)].flatMap((m) => m[1]!.split(",")),
      );
      const used = [
        ...data.source.matchAll(/:::(tone-\w+(?:-\w+)*)/g),
        ...data.source.matchAll(/^\s*class\s+\S+\s+(tone-\w+(?:-\w+)*)/gm),
        ...data.source.matchAll(/(?:stroke|fill|color):(tone-\w+(?:-\w+)*)/g),
      ].map((m) => m[1]!);
      for (const name of new Set(used)) {
        if (defined.has(name) || toneSchema.safeParse(name.slice(5)).success) continue;
        findings.push({
          severity: "warning",
          ...at(node),
          message: `<Mermaid> "${name}" is not a palette tone, so it styles nothing. Tones: ${toneSchema.options.map((tone) => `tone-${tone}`).join(", ")}.`,
        });
      }
    }
    // vocabulary v2: table — rows may be `{ tone, cells }`; cells may be objects.
    if (tag === "Table") {
      const { columns, rows, align } = data as TableData;
      const cellRows = rows.map((row) => rowParts(row).cells);
      const ragged = cellRows.flatMap((cells, index) =>
        cells.length === columns.length ? [] : [index + 1],
      );
      if (columns.length && ragged.length) {
        findings.push({
          severity: "warning",
          ...at(node),
          message: `<Table> row${ragged.length > 1 ? "s" : ""} ${ragged.join(", ")} ${ragged.length > 1 ? "do" : "does"} not have ${columns.length} cells to match the columns — the grid renders ragged.`,
        });
      }
      const empty = cellRows.flatMap((cells, row) =>
        cells.flatMap((cell, col) =>
          typeof cell === "object" && !cell.md && !cell.badge ? [`${row + 1}:${col + 1}`] : [],
        ),
      );
      if (empty.length) {
        findings.push({
          severity: "warning",
          ...at(node),
          message: `<Table> cell object${empty.length > 1 ? "s" : ""} at row:column ${empty.join(", ")} ${empty.length > 1 ? "have" : "has"} neither "md" nor "badge" — it renders empty.`,
        });
      }
      if (align && align.length !== columns.length) {
        findings.push({
          severity: "warning",
          ...at(node),
          message: `<Table> "align" has ${align.length} entr${align.length === 1 ? "y" : "ies"} for ${columns.length} columns — extra entries are ignored and missing ones default to left.`,
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
      for (const message of new Set(stripped)) {
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
