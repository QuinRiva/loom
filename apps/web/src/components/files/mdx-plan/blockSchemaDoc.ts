/**
 * Generates `skills/mdx-doc-core/references/block-schema.md` from the live zod schemas;
 * `blockSchemaDoc.test.ts` fails CI when the checked-in file drifts.
 * Regenerate: `UPDATE_BLOCK_SCHEMA=1 pnpm --filter @t3tools/web test run blockSchemaDoc`
 */
import { PLAN_BLOCKS } from "./registry";

// zod's runtime `_def` shape is untyped for our purposes; the schemas are cast
// to `z.ZodType<T>` at compile time but remain concrete ZodObject/ZodArray/…
// nodes at runtime, so we introspect via `any`.
type AnyDef = any;

function def(zt: any): AnyDef {
  return zt?._def;
}

/** Peel ZodOptional / ZodNullable / ZodDefault, tracking optionality, nullability
 * (rendered as `T | null`, so the reference matches the schema — a nullable prop
 * distinguishes present-null from absent), and any default value. */
function unwrap(zt: any): {
  inner: any;
  optional: boolean;
  nullable: boolean;
  defaultValue?: unknown;
} {
  let cur = zt;
  let optional = false;
  let nullable = false;
  let defaultValue: unknown;
  for (;;) {
    const tn = def(cur)?.typeName;
    if (tn === "ZodOptional") {
      optional = true;
      cur = def(cur).innerType;
    } else if (tn === "ZodNullable") {
      nullable = true;
      cur = def(cur).innerType;
    } else if (tn === "ZodDefault") {
      optional = true;
      defaultValue = def(cur).defaultValue();
      cur = def(cur).innerType;
    } else {
      break;
    }
  }
  return { inner: cur, optional, nullable, defaultValue };
}

/** `{ label, tone? }` — an object alternative named by its keys, so a union reads
 * as `string | { label, tone? }` and each alternative is nested under that name. */
function objectLabel(objSchema: any): string {
  const keys = Object.entries(shapeOf(objSchema)).map(([key, raw]) =>
    unwrap(raw).optional ? `${key}?` : key,
  );
  return `{ ${keys.join(", ")} }`;
}

/** A one-line type label for a fully-unwrapped schema node. */
function typeLabel(zt: any): string {
  const d = def(zt);
  switch (d?.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return (d.checks ?? []).some((c: any) => c.kind === "int") ? "integer" : "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      return d.values.map((v: string) => JSON.stringify(v)).join(" | ");
    case "ZodLiteral":
      return JSON.stringify(d.value);
    case "ZodArray": {
      const label = typeLabel(unwrap(d.type).inner);
      return label.includes(" | ") ? `(${label})[]` : `${label}[]`; // a union or an enum
    }
    case "ZodObject":
      return "object";
    case "ZodUnion":
      return d.options
        .map((o: any) => {
          const option = unwrap(o).inner;
          return def(option)?.typeName === "ZodObject" ? objectLabel(option) : typeLabel(option);
        })
        .join(" | ");
    default:
      return d?.typeName ?? "unknown";
  }
}

/** The object nodes to nest under a prop: an object, reached through arrays
 * and unions. `viaUnion` marks an alternative, which is nested under its
 * {@link objectLabel} so the reader can tell the alternatives apart. */
function nestedObjects(inner: any, viaUnion = false): Array<{ schema: any; viaUnion: boolean }> {
  const d = def(inner);
  if (d?.typeName === "ZodObject") return [{ schema: inner, viaUnion }];
  if (d?.typeName === "ZodArray") return nestedObjects(unwrap(d.type).inner, viaUnion);
  if (d?.typeName === "ZodUnion")
    return d.options.flatMap((o: any) => nestedObjects(unwrap(o).inner, true));
  return [];
}

function shapeOf(objSchema: any): Record<string, any> {
  return objSchema.shape ?? {};
}

/** Render an object schema's props as a nested markdown bullet list. */
function renderProps(objSchema: any, indent: string, childrenField?: string): string[] {
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(shapeOf(objSchema))) {
    const { inner, optional, nullable, defaultValue } = unwrap(raw);
    const typeStr = nullable ? `${typeLabel(inner)} | null` : typeLabel(inner);
    const parts = [`${indent}- \`${name}\`: \`${typeStr}\``];
    parts.push(optional ? "_(optional)_" : "**(required)**");
    if (defaultValue !== undefined) parts.push(`default \`${JSON.stringify(defaultValue)}\``);
    if (name === childrenField)
      parts.push("(written as **prose between the tags**, not an attribute)");
    lines.push(parts.join(" "));
    for (const nested of nestedObjects(inner)) {
      if (!nested.viaUnion) lines.push(...renderProps(nested.schema, `${indent}  `));
      else
        lines.push(
          `${indent}  - \`${objectLabel(nested.schema)}\` form:`,
          ...renderProps(nested.schema, `${indent}    `),
        );
    }
  }
  return lines;
}

export function generateBlockSchemaDoc(): string {
  const out: string[] = [
    "<!-- GENERATED FILE. Do not edit by hand.",
    "     Source of truth: the zod `schema` exports in",
    "     apps/web/src/components/files/mdx-plan/blocks/*.tsx (+ registry.tsx).",
    "     Regenerate: UPDATE_BLOCK_SCHEMA=1 pnpm --filter @t3tools/web test run blockSchemaDoc",
    "     The drift test blockSchemaDoc.test.ts fails CI if this file and the schemas disagree. -->",
    "",
    "# MDX plan block schema reference",
    "",
    "Authoritative prop shapes for every plan block, generated from the live zod",
    "schemas. **Do not guess props or enum values: consult this file.** Every prop",
    "lists its type, whether it is required or optional, allowed enum values, and any",
    "nested object/array sub-shape. Unlisted props are rejected by validation.",
    "",
    "## Encoding recap",
    "",
    '- String → `attr="value"` (or `attr={"…\\n…"}` for multi-line / special chars).',
    "- Number → `attr={12}`; boolean true → bare `attr` (omit for false).",
    "- Array / object → a JSON literal in braces with double-quoted keys, e.g.",
    '  `entities={[{ "id": "user", "name": "User", "fields": [] }]}`.',
    "- No free `{expressions}` in the body or as attribute values: literal data only.",
    "",
    "## Gotchas that have bitten authors",
    "",
    '- `<DataModel>` field `fk` is a **string FK target** (e.g. `"Value.value_id"`),',
    "  NOT a boolean. `fk: true` is invalid.",
    '- `<DataModel>` relation `kind` is one of `"1-1" | "1-n" | "n-n"`. There is',
    '  **no `"n-1"`**. Model many-to-one as `"1-n"` with `from`/`to` flipped (from',
    '  the "one" side to the "many" side).',
    "- Enum props accept only the listed values; anything else fails validation and",
    "  the block renders an error card instead of the block.",
    "",
  ];

  for (const { tag, type, block } of PLAN_BLOCKS) {
    const childrenField = block.mdx.childrenField as string | undefined;
    out.push(`## \`<${tag}>\`: \`${type}\``, "");
    if (block.mdx.inline) {
      out.push("Inline element: the **text between its tags** is its label.", "");
    } else if (block.mdx.passChildren && !childrenField) {
      out.push(
        "Container block: renders nested plan blocks written **between its tags** as children.",
        "",
      );
    }
    const props = renderProps(block.schema, "", childrenField);
    if (props.length === 0) {
      out.push("_No attributes._", "");
    } else {
      out.push("Props:", "", ...props, "");
    }
  }

  return `${out.join("\n").trimEnd()}\n`;
}
