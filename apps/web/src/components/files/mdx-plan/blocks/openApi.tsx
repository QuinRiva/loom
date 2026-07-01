import { IconChevronRight, IconLock } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<OpenApi>` block — a Redoc / Swagger-UI-style API reference rendered from
 * a whole OpenAPI 3 / Swagger 2 document. The raw `spec` TEXT is the source of
 * truth; the reader parses it defensively and, on any parse error, falls back to
 * the raw text + the error (it never throws). Operations are grouped by tag,
 * each a collapsed-by-default row expanding to params / request body / per-status
 * responses, with `$ref` models resolved. v1 parses JSON specs only (no `yaml`
 * dependency). The defensive parser (`parseSpec`/`normalizeSpec`/`deref`/…) is
 * ported verbatim from `@agent-native/core` `OpenApiSpecBlock.tsx`; the render is
 * slimmed to the read surface (BuilderIO's `ctx.renderMarkdown`/`CodeSurface` are
 * dropped — descriptions render as text, examples as `<pre>`). Schema + MDX
 * round-trip ported from `openapi-spec.config.ts` (`title`/`spec` flat attrs).
 */

export interface OpenApiSpecData {
  spec: string;
  title?: string;
}

export const openApiSpecSchema = z.object({
  spec: z.string().max(400_000),
  title: z.string().trim().max(200).optional(),
}) as unknown as z.ZodType<OpenApiSpecData>;

export const openApiMdx: BlockMdxConfig<OpenApiSpecData> = {
  tag: "OpenApi",
  toAttrs: (data) => ({ title: data.title, spec: data.spec }),
  fromAttrs: (attrs) =>
    ({
      spec: attrs.string("spec") ?? "",
      title: attrs.string("title"),
    }) as OpenApiSpecData,
};

/* ── Defensive spec parsing + normalization (verbatim port) ─────────────────── */

type Json = unknown;
type JsonObject = Record<string, Json>;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;

interface NormalizedParam {
  name: string;
  in: string;
  type?: string | undefined;
  required?: boolean | undefined;
  description?: string | undefined;
}
interface NormalizedResponse {
  status: string;
  description?: string | undefined;
  example?: string | undefined;
}
interface NormalizedOperation {
  id: string;
  method: string;
  path: string;
  summary?: string | undefined;
  description?: string | undefined;
  deprecated?: boolean | undefined;
  secured?: boolean | undefined;
  tags: string[];
  params: NormalizedParam[];
  requestContentType?: string | undefined;
  requestExample?: string | undefined;
  responses: NormalizedResponse[];
}
interface NormalizedTagGroup {
  tag: string;
  description?: string | undefined;
  operations: NormalizedOperation[];
}
interface NormalizedSpec {
  title?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
  format: "OpenAPI 3" | "Swagger 2" | "Unknown";
  groups: NormalizedTagGroup[];
  operationCount: number;
}
interface ParseResult {
  ok: boolean;
  spec?: NormalizedSpec;
  error?: string;
}

function isObject(value: Json): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asString(value: Json): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseSpec(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed)
    return { ok: false, error: "Empty spec — paste an OpenAPI 3 / Swagger 2 document." };
  let doc: Json;
  try {
    doc = JSON.parse(trimmed);
  } catch (error) {
    const hint =
      /^[A-Za-z][\w-]*\s*:/.test(trimmed) || trimmed.startsWith("---")
        ? " (YAML is not supported yet — paste JSON, or convert the spec to JSON.)"
        : "";
    return {
      ok: false,
      error: `${error instanceof Error ? error.message : "Invalid JSON"}${hint}`,
    };
  }
  if (!isObject(doc)) return { ok: false, error: "Spec must be a JSON object." };
  try {
    return { ok: true, spec: normalizeSpec(doc) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not interpret the spec document.",
    };
  }
}

function resolveRef(root: JsonObject, ref: string, seen: Set<string>): Json | undefined {
  if (!ref.startsWith("#/")) return undefined;
  if (seen.has(ref)) return undefined;
  seen.add(ref);
  const segments = ref
    .slice(2)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: Json = root;
  for (const segment of segments) {
    if (!isObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function deref(root: JsonObject, value: Json, seen: Set<string>): Json {
  let current = value;
  let guard = 0;
  while (isObject(current) && typeof current.$ref === "string" && guard < 20) {
    const resolved = resolveRef(root, current.$ref, seen);
    if (resolved === undefined) return current;
    current = resolved;
    guard += 1;
  }
  return current;
}

function schemaTypeLabel(root: JsonObject, schema: Json, seen: Set<string>): string | undefined {
  const resolved = deref(root, schema, new Set(seen));
  if (!isObject(resolved)) return undefined;
  if (typeof resolved.type === "string") {
    if (resolved.type === "array" && resolved.items) {
      const inner = schemaTypeLabel(root, resolved.items, seen);
      return inner ? `${inner}[]` : "array";
    }
    return resolved.type;
  }
  if (resolved.$ref && typeof resolved.$ref === "string") return resolved.$ref.split("/").pop();
  if (resolved.enum) return "enum";
  if (resolved.properties) return "object";
  if (resolved.oneOf || resolved.anyOf || resolved.allOf) return "object";
  return undefined;
}

function schemaExample(root: JsonObject, schema: Json, seen: Set<string>, depth: number): Json {
  if (depth > 6) return "…";
  const resolved = deref(root, schema, new Set(seen));
  if (!isObject(resolved)) return resolved ?? null;
  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum[0];

  const allOf = Array.isArray(resolved.allOf) ? resolved.allOf : null;
  if (allOf) {
    const merged: JsonObject = {};
    for (const part of allOf) {
      const value = schemaExample(root, part, seen, depth + 1);
      if (isObject(value)) Object.assign(merged, value);
    }
    if (Object.keys(merged).length > 0) return merged;
  }
  const oneOf =
    (Array.isArray(resolved.oneOf) && resolved.oneOf) ||
    (Array.isArray(resolved.anyOf) && resolved.anyOf) ||
    null;
  if (oneOf && oneOf.length > 0) return schemaExample(root, oneOf[0], seen, depth + 1);

  const type = resolved.type;
  if (type === "object" || resolved.properties) {
    const props = isObject(resolved.properties) ? resolved.properties : {};
    const out: JsonObject = {};
    for (const [key, propSchema] of Object.entries(props).slice(0, 30)) {
      out[key] = schemaExample(root, propSchema, seen, depth + 1);
    }
    return out;
  }
  if (type === "array") return [schemaExample(root, resolved.items ?? {}, seen, depth + 1)];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return true;
  if (type === "string") {
    if (resolved.format === "date-time") return "2020-01-01T00:00:00Z";
    if (resolved.format === "uuid") return "00000000-0000-0000-0000-000000000000";
    return "string";
  }
  return null;
}

function stringifyExample(value: Json): string | undefined {
  try {
    const text = JSON.stringify(value, null, 2);
    if (!text || text === "null" || text === "{}" || text === "[]") return undefined;
    return text.length > 8_000 ? `${text.slice(0, 8_000)}\n…` : text;
  } catch {
    return undefined;
  }
}

function normalizeParam(
  root: JsonObject,
  raw: Json,
  seen: Set<string>,
): NormalizedParam | undefined {
  const param = deref(root, raw, new Set(seen));
  if (!isObject(param)) return undefined;
  const name = asString(param.name);
  const location = asString(param.in);
  if (!name || !location) return undefined;
  const type = schemaTypeLabel(root, param.schema, seen) ?? asString(param.type);
  return {
    name,
    in: location,
    type,
    required: param.required === true,
    description: asString(param.description),
  };
}

function normalizeOperation(
  root: JsonObject,
  path: string,
  method: string,
  rawOp: Json,
  pathLevelParams: NormalizedParam[],
  seen: Set<string>,
): NormalizedOperation | undefined {
  if (!isObject(rawOp)) return undefined;

  const params: NormalizedParam[] = [...pathLevelParams];
  if (Array.isArray(rawOp.parameters)) {
    for (const rawParam of rawOp.parameters) {
      const normalized = normalizeParam(root, rawParam, seen);
      if (normalized) params.push(normalized);
    }
  }

  let requestContentType: string | undefined;
  let requestExample: string | undefined;
  const requestBody = deref(root, rawOp.requestBody, new Set(seen));
  if (isObject(requestBody) && isObject(requestBody.content)) {
    const [contentType, media] = Object.entries(requestBody.content)[0] ?? [];
    requestContentType = contentType;
    if (isObject(media)) {
      requestExample =
        stringifyExample(media.example) ??
        stringifyExample(schemaExample(root, media.schema, seen, 0));
    }
  } else {
    const bodyParam = params.find((p) => p.in === "body");
    if (bodyParam) {
      const rawBody = Array.isArray(rawOp.parameters)
        ? rawOp.parameters.find(
            (p) =>
              isObject(deref(root, p, new Set(seen))) &&
              asString((deref(root, p, new Set(seen)) as JsonObject).in) === "body",
          )
        : undefined;
      const resolvedBody = isObject(deref(root, rawBody, new Set(seen)))
        ? (deref(root, rawBody, new Set(seen)) as JsonObject)
        : undefined;
      requestContentType = "application/json";
      requestExample = stringifyExample(schemaExample(root, resolvedBody?.schema, seen, 0));
    }
  }
  const visibleParams = params.filter((p) => p.in !== "body");

  const responses: NormalizedResponse[] = [];
  if (isObject(rawOp.responses)) {
    for (const [status, rawResponse] of Object.entries(rawOp.responses)) {
      const response = deref(root, rawResponse, new Set(seen));
      let example: string | undefined;
      if (isObject(response)) {
        if (isObject(response.content)) {
          const media = Object.values(response.content)[0];
          if (isObject(media)) {
            example =
              stringifyExample(media.example) ??
              stringifyExample(schemaExample(root, media.schema, seen, 0));
          }
        } else if (response.schema) {
          example = stringifyExample(schemaExample(root, response.schema, seen, 0));
        }
      }
      responses.push({
        status,
        description: isObject(response) ? asString(response.description) : undefined,
        example,
      });
    }
  }

  const tags =
    Array.isArray(rawOp.tags) && rawOp.tags.length > 0
      ? rawOp.tags.filter((t): t is string => typeof t === "string")
      : [];
  const secured =
    Array.isArray(rawOp.security) && rawOp.security.length > 0
      ? rawOp.security.some((req) => isObject(req) && Object.keys(req).length > 0)
      : undefined;

  return {
    id: `${method}-${path}`,
    method: method.toUpperCase(),
    path,
    summary: asString(rawOp.summary),
    description: asString(rawOp.description),
    deprecated: rawOp.deprecated === true,
    secured,
    tags: tags.length > 0 ? tags : ["default"],
    params: visibleParams,
    requestContentType,
    requestExample,
    responses: responses.sort((a, b) => a.status.localeCompare(b.status)),
  };
}

function normalizeSpec(doc: JsonObject): NormalizedSpec {
  const format: NormalizedSpec["format"] =
    typeof doc.openapi === "string"
      ? "OpenAPI 3"
      : typeof doc.swagger === "string"
        ? "Swagger 2"
        : "Unknown";
  const info = isObject(doc.info) ? doc.info : undefined;
  const globalSecured =
    Array.isArray(doc.security) &&
    doc.security.some((req) => isObject(req) && Object.keys(req).length > 0);

  const tagOrder: string[] = [];
  const tagDescriptions = new Map<string, string>();
  if (Array.isArray(doc.tags)) {
    for (const tag of doc.tags) {
      if (isObject(tag) && typeof tag.name === "string") {
        tagOrder.push(tag.name);
        if (typeof tag.description === "string") tagDescriptions.set(tag.name, tag.description);
      }
    }
  }

  const groups = new Map<string, NormalizedOperation[]>();
  let operationCount = 0;
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = deref(doc, rawPathItem, new Set());
    if (!isObject(pathItem)) continue;
    const pathLevelParams: NormalizedParam[] = [];
    if (Array.isArray(pathItem.parameters)) {
      for (const rawParam of pathItem.parameters) {
        const normalized = normalizeParam(doc, rawParam, new Set());
        if (normalized) pathLevelParams.push(normalized);
      }
    }
    for (const method of HTTP_METHODS) {
      const rawOp = pathItem[method];
      if (!isObject(rawOp)) continue;
      const operation = normalizeOperation(doc, path, method, rawOp, pathLevelParams, new Set());
      if (!operation) continue;
      if (operation.secured === undefined && globalSecured) operation.secured = true;
      operationCount += 1;
      for (const tag of operation.tags) {
        const list = groups.get(tag) ?? [];
        list.push(operation);
        groups.set(tag, list);
      }
    }
  }

  const orderedTagNames = [
    ...tagOrder.filter((tag) => groups.has(tag)),
    ...[...groups.keys()]
      .filter((tag) => !tagOrder.includes(tag))
      .sort((a, b) => a.localeCompare(b)),
  ];
  const groupList: NormalizedTagGroup[] = orderedTagNames.map((tag) => ({
    tag,
    description: tagDescriptions.get(tag),
    operations: groups.get(tag) ?? [],
  }));

  return {
    title: info ? asString(info.title) : undefined,
    version: info ? asString(info.version) : undefined,
    description: info ? asString(info.description) : undefined,
    format,
    groups: groupList,
    operationCount,
  };
}

/* ── Render (slim read surface) ─────────────────────────────────────────────── */

const METHOD_PILL: Record<string, string> = {
  GET: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  POST: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  PUT: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  PATCH: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  DELETE: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};
const PARAM_IN_BADGE: Record<string, string> = {
  path: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  query: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  header: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  cookie: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
};
const FALLBACK_PILL = "bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300";

function statusPill(status: string): string {
  const lead = status.trim()[0];
  if (lead === "2")
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
  if (lead === "4") return "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300";
  if (lead === "5") return "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300";
  return FALLBACK_PILL;
}

function OperationRow({ operation }: { operation: NormalizedOperation }) {
  const [open, setOpen] = useState(false);
  const hasBody =
    Boolean(operation.description?.trim()) ||
    operation.params.length > 0 ||
    Boolean(operation.requestExample || operation.requestContentType) ||
    operation.responses.length > 0;

  return (
    <div className="border-t border-border first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => hasBody && setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2 text-left",
          hasBody && "hover:bg-accent/40",
        )}
      >
        {hasBody && (
          <IconChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
        <span
          className={cn(
            "shrink-0 rounded-md px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wide",
            METHOD_PILL[operation.method] ?? FALLBACK_PILL,
          )}
        >
          {operation.method}
        </span>
        <span
          className={cn(
            "min-w-0 truncate font-mono text-sm font-semibold text-foreground",
            operation.deprecated && "line-through",
          )}
        >
          {operation.path}
        </span>
        {operation.summary && (
          <span className="ml-1 min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {operation.summary}
          </span>
        )}
        {operation.secured && (
          <IconLock
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label="Requires authentication"
          />
        )}
      </button>

      {open && hasBody && (
        <div className="border-t border-border/60 bg-muted/20 px-3 py-3">
          {operation.description?.trim() && (
            <p className="text-sm text-muted-foreground">{operation.description}</p>
          )}
          {operation.params.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Parameters
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {operation.params.map((param) => (
                  <div
                    key={`${param.in}-${param.name}`}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                        PARAM_IN_BADGE[param.in] ?? FALLBACK_PILL,
                      )}
                    >
                      {param.in}
                    </span>
                    <span className="font-mono text-xs font-semibold text-foreground">
                      {param.name}
                    </span>
                    {param.type && (
                      <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {param.type}
                      </span>
                    )}
                    {param.required && (
                      <span className="text-[10px] font-semibold uppercase text-red-600 dark:text-red-300">
                        required
                      </span>
                    )}
                    {param.description && (
                      <span className="text-[11px] italic text-muted-foreground">
                        — {param.description}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {(operation.requestExample || operation.requestContentType) && (
            <div className="mt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Request{operation.requestContentType ? ` · ${operation.requestContentType}` : ""}
              </div>
              {operation.requestExample && (
                <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] text-foreground">
                  {operation.requestExample}
                </pre>
              )}
            </div>
          )}
          {operation.responses.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Responses
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {operation.responses.map((response) => (
                  <div key={response.status}>
                    <div className="flex items-center gap-2 text-sm">
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-bold",
                          statusPill(response.status),
                        )}
                      >
                        {response.status}
                      </span>
                      {response.description && (
                        <span className="text-xs text-muted-foreground">
                          {response.description}
                        </span>
                      )}
                    </div>
                    {response.example && (
                      <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] text-foreground">
                        {response.example}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TagGroup({ group, defaultOpen }: { group: NormalizedTagGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/40"
      >
        <IconChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="font-semibold text-foreground">{group.tag}</span>
        <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {group.operations.length}
        </span>
        {group.description && (
          <span className="ml-1 min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {group.description}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-border">
          {group.operations.map((operation) => (
            <OperationRow key={operation.id} operation={operation} />
          ))}
        </div>
      )}
    </div>
  );
}

export function OpenApiRead({ data, blockId }: PlanBlockReadProps<OpenApiSpecData>) {
  const parsed = useMemo(() => parseSpec(data.spec), [data.spec]);
  return (
    <section
      data-plan-block-id={blockId}
      data-plan-block-type="openapi-spec"
      className="my-4 flex flex-col gap-3"
    >
      {parsed.ok && parsed.spec ? (
        <>
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-foreground">
                {data.title || parsed.spec.title || "API reference"}
              </span>
              {parsed.spec.version && (
                <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  v{parsed.spec.version}
                </span>
              )}
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {parsed.spec.format}
              </span>
              <span className="text-xs text-muted-foreground">
                {parsed.spec.operationCount}{" "}
                {parsed.spec.operationCount === 1 ? "operation" : "operations"}
              </span>
            </div>
            {parsed.spec.description?.trim() && (
              <p className="mt-2 text-sm text-muted-foreground">{parsed.spec.description}</p>
            )}
          </div>
          {parsed.spec.groups.length === 0 ? (
            <div className="rounded-xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              No operations found in this spec.
            </div>
          ) : (
            parsed.spec.groups.map((group, index) => (
              <TagGroup key={group.tag} group={group} defaultOpen={index === 0} />
            ))
          )}
        </>
      ) : (
        <div className="overflow-hidden rounded-xl border border-destructive/40 bg-destructive/5">
          <div className="border-b border-border/60 px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {data.title || "OpenAPI"}
          </div>
          <div className="space-y-2 px-3 py-2.5">
            <p className="text-xs text-destructive">Could not parse spec: {parsed.error}</p>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] text-foreground">
              {data.spec || "—"}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}

export const openApiBlock: PlanBlock<OpenApiSpecData> = {
  schema: openApiSpecSchema,
  mdx: openApiMdx,
  Read: OpenApiRead,
};
