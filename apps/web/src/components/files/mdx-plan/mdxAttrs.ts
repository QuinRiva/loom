import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { BlockAttrReader, MdxAttrValue } from "./blockTypes";

/**
 * The MDX attribute round-trip primitives — the byte-stable serialize/parse
 * contract for plan blocks. Ported (kept behaviourally identical) from
 * BuilderIO's `@agent-native/core` `client/blocks/mdx.ts` so authored `.mdx`
 * plans round-trip the same. React-free.
 *
 * Serialize (`prop`): scalars → quoted/short-string or `={n}`/`={bool}` attrs;
 * objects/arrays/long strings → a JSON expression attr `={…}`. Parse
 * (`createAttrReader`): resolves both plain-string attrs and expression attrs
 * (via the estree literal walker, falling back to `JSON.parse`).
 */

/* -------------------------------------------------------------------------- */
/* Serialize                                                                  */
/* -------------------------------------------------------------------------- */

export function jsonExpression(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Encode one attribute. Returns "" (dropped) for undefined/null; a bare/`={false}`
 * flag for booleans; `={n}` for numbers; a quoted string when short + safe, else
 * a JSON expression. Objects/arrays always serialize as a JSON expression.
 */
export function prop(name: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? ` ${name}` : ` ${name}={false}`;
  if (typeof value === "number") return ` ${name}={${value}}`;
  if (typeof value === "string") {
    if (/^[\w .:/@#,+()[\]-]+$/.test(value) && value.length < 140) {
      return ` ${name}="${escapeAttr(value)}"`;
    }
    return ` ${name}={${jsonExpression(value)}}`;
  }
  return ` ${name}={${jsonExpression(value)}}`;
}

/** Serialize a self-closing plan-block element from its tag + attribute bag. */
export function serializeBlockElement(
  tag: string,
  attrs: Record<string, MdxAttrValue | undefined>,
): string {
  const attrStr = Object.entries(attrs)
    .map(([key, value]) => prop(key, value))
    .join("");
  return `<${tag}${attrStr} />`;
}

/* -------------------------------------------------------------------------- */
/* Parse                                                                      */
/* -------------------------------------------------------------------------- */

export type MdxAttrExpression = { type: string; value: string; data?: unknown };
export type MdxAttrNode = {
  type: string;
  name?: string;
  value?: string | null | MdxAttrExpression;
};
export type MdxJsxNode = {
  type: string;
  name?: string;
  attributes?: MdxAttrNode[];
  children?: unknown[];
};

type EstreeTemplateElement = { type: string; value?: { cooked?: string | null; raw?: string } };
type EstreeNode = {
  type: string;
  value?: unknown;
  name?: string;
  expression?: EstreeNode;
  body?: EstreeNode[];
  elements?: Array<EstreeNode | null>;
  properties?: EstreeNode[];
  key?: EstreeNode;
  computed?: boolean;
  argument?: EstreeNode;
  operator?: string;
  quasis?: EstreeTemplateElement[];
  expressions?: EstreeNode[];
};

function findAttribute(node: MdxJsxNode, name: string): MdxAttrNode | undefined {
  return node.attributes?.find((attr) => attr.type === "mdxJsxAttribute" && attr.name === name);
}

export function attributeValue(attr: MdxAttrNode | undefined): unknown {
  if (!attr) return undefined;
  if (attr.value === null || attr.value === undefined) return true;
  if (typeof attr.value === "string") return attr.value;
  const astValue = literalExpressionValue(attr.value);
  if (astValue !== undefined) return astValue;
  const expression = attr.value.value.trim();
  if (!expression || expression === "undefined") return undefined;
  try {
    return JSON.parse(expression);
  } catch {
    throw new Error(
      `Unsupported MDX attribute expression for "${attr.name}": {${expression}}. Use literal values or valid JSON.`,
    );
  }
}

function literalExpressionValue(expression: MdxAttrExpression): unknown {
  const estree = (expression.data as { estree?: EstreeNode } | undefined)?.estree;
  const statement = estree?.body?.[0];
  if (!statement || statement.type !== "ExpressionStatement") return undefined;
  return literalNodeValue(statement.expression);
}

function literalNodeValue(node: EstreeNode | undefined | null): unknown {
  if (!node) return undefined;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral") {
    if ((node.expressions?.length ?? 0) > 0) {
      throw new Error(
        "Template literal attribute values may not contain ${…} expressions; use a static string.",
      );
    }
    return node.quasis?.[0]?.value?.cooked ?? "";
  }
  if (node.type === "ArrayExpression") {
    return (node.elements ?? []).map((item) => literalNodeValue(item));
  }
  if (node.type === "ObjectExpression") {
    const out: Record<string, unknown> = {};
    for (const property of node.properties ?? []) {
      if (property.type !== "Property" || property.computed) return undefined;
      const key = property.key;
      const rawKey =
        key?.type === "Identifier"
          ? key.name
          : key?.type === "Literal" && typeof key.value === "string"
            ? key.value
            : undefined;
      if (!rawKey) return undefined;
      const value = literalNodeValue(property.value as EstreeNode | undefined);
      if (value !== undefined) out[rawKey] = value;
    }
    return out;
  }
  if (node.type === "UnaryExpression") {
    const value = literalNodeValue(node.argument);
    if (typeof value !== "number") return undefined;
    if (node.operator === "-") return -value;
    if (node.operator === "+") return value;
  }
  if (node.type === "Identifier") {
    if (node.name === "undefined") return undefined;
    if (node.name === "NaN") return Number.NaN;
    if (node.name === "Infinity") return Infinity;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Render-path guard: reject non-literal attribute expressions                */
/* -------------------------------------------------------------------------- */

const attrExprError = (name: string) =>
  new Error(
    `Disallowed MDX attribute expression for "${name}": only literal values ` +
      `(strings, numbers, booleans, arrays, objects) are permitted in plans, ` +
      `not executable expressions.`,
  );

/** Throw unless `node` is a static JSON-literal estree node (the block wire
 * format). Anything that can execute — calls, sequences, functions, member
 * access, arbitrary identifiers — is rejected. */
function assertLiteralNode(name: string, node: EstreeNode | null | undefined): void {
  if (!node) return; // array holes / omitted values are inert
  switch (node.type) {
    case "Literal":
      return;
    case "TemplateLiteral":
      if ((node.expressions?.length ?? 0) > 0) throw attrExprError(name);
      return;
    case "ArrayExpression":
      for (const element of node.elements ?? []) assertLiteralNode(name, element);
      return;
    case "ObjectExpression":
      for (const property of node.properties ?? []) {
        if (property.type !== "Property" || property.computed) throw attrExprError(name);
        const key = property.key;
        if (key?.type !== "Identifier" && key?.type !== "Literal") throw attrExprError(name);
        assertLiteralNode(name, property.value as EstreeNode | undefined);
      }
      return;
    case "UnaryExpression":
      if (node.operator === "-" || node.operator === "+" || node.operator === "!") {
        assertLiteralNode(name, node.argument);
        return;
      }
      throw attrExprError(name);
    case "Identifier":
      if (node.name === "undefined" || node.name === "NaN" || node.name === "Infinity") return;
      throw attrExprError(name);
    default:
      throw attrExprError(name);
  }
}

/**
 * Compile-time guard for the render path: assert that an MDX attribute-value
 * expression (`attr={…}`) is a static literal, not executable JS. Reuses the
 * same estree literal shapes the parse path accepts, so the JSON-literal wire
 * format (`entities={[…]}`, `data={{…}}`, `code={"…"}`, `={123}`, `={true}`)
 * passes while `code={fetch(...)}`, sequence/IIFE tricks, etc. throw. Fails
 * closed: an expression whose estree is missing or is not a single expression
 * statement is rejected.
 */
export function assertLiteralAttributeExpression(name: string, value: MdxAttrExpression): void {
  const body = (value.data as { estree?: EstreeNode } | undefined)?.estree?.body;
  const statement = body?.[0];
  if (!body || body.length !== 1 || statement?.type !== "ExpressionStatement") {
    throw attrExprError(name);
  }
  assertLiteralNode(name, statement.expression);
}

/** Build a {@link BlockAttrReader} bound to one parsed JSX node. */
export function createAttrReader(node: MdxJsxNode): BlockAttrReader {
  const read = (name: string) => attributeValue(findAttribute(node, name));
  return {
    raw: read,
    string(name) {
      const value = read(name);
      return typeof value === "string" ? value : undefined;
    },
    number(name) {
      const value = read(name);
      return typeof value === "number" ? value : undefined;
    },
    bool(name) {
      const value = read(name);
      return typeof value === "boolean" ? value : undefined;
    },
    array<T = unknown>(name: string) {
      const value = read(name);
      return Array.isArray(value) ? (value as T[]) : undefined;
    },
    object<T = unknown>(name: string) {
      const value = read(name);
      return value && typeof value === "object" ? (value as T) : undefined;
    },
  };
}

const mdxParser = unified().use(remarkParse).use(remarkMdx);

/** Parse an MDX source string → the first JSX block element node (or null). */
export function parseFirstJsxBlock(source: string): MdxJsxNode | null {
  const tree = mdxParser.parse(source) as { children?: MdxJsxNode[] };
  for (const child of tree.children ?? []) {
    if (child.type === "mdxJsxFlowElement" && child.name) return child;
  }
  return null;
}
