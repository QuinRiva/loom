import { IconChevronRight } from "@tabler/icons-react";
import { useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<Endpoint>` block — one API operation: a method pill + monospace path
 * that expands to params (grouped by location), an optional request example, and
 * per-status responses. The prose *between the tags* is the description (rendered
 * live as MDX children). Schema + MDX round-trip ported verbatim from
 * `@agent-native/core` `api-endpoint.config.ts`.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type ParamLocation = "path" | "query" | "header" | "body";
export type EndpointChange = "added" | "modified" | "removed" | "renamed";

export interface EndpointParam {
  name: string;
  in: ParamLocation;
  type?: string;
  required?: boolean;
  description?: string;
  change?: EndpointChange;
  was?: string;
}

export interface EndpointResponse {
  status: string;
  description?: string;
  example?: string;
  change?: EndpointChange;
}

export interface EndpointData {
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  auth?: string;
  deprecated?: boolean;
  change?: EndpointChange;
  params?: EndpointParam[];
  request?: { contentType?: string; example?: string };
  responses?: EndpointResponse[];
}

const changeSchema = z.enum(["added", "modified", "removed", "renamed"]);

const paramSchema = z.object({
  name: z.string().trim().min(1).max(160),
  in: z.enum(["path", "query", "header", "body"]),
  type: z.string().trim().max(120).optional(),
  required: z.boolean().optional(),
  description: z.string().trim().max(1000).optional(),
  change: changeSchema.optional(),
  was: z.string().trim().max(400).optional(),
}) as z.ZodType<EndpointParam>;

const responseSchema = z.object({
  status: z.string().trim().min(1).max(40),
  description: z.string().trim().max(1000).optional(),
  example: z.string().max(20_000).optional(),
  change: changeSchema.optional(),
}) as z.ZodType<EndpointResponse>;

export const endpointSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  path: z.string().trim().min(1).max(500),
  summary: z.string().trim().max(400).optional(),
  description: z.string().trim().max(20_000).optional(),
  auth: z.string().trim().max(200).optional(),
  deprecated: z.boolean().optional(),
  change: changeSchema.optional(),
  params: z.array(paramSchema).max(60).optional(),
  request: z
    .object({
      contentType: z.string().trim().max(160).optional(),
      example: z.string().max(20_000).optional(),
    })
    .optional(),
  responses: z.array(responseSchema).max(40).optional(),
}) as unknown as z.ZodType<EndpointData>;

export const endpointMdx: BlockMdxConfig<EndpointData> = {
  tag: "Endpoint",
  childrenField: "description",
  toAttrs: (data) => ({
    method: data.method,
    path: data.path,
    summary: data.summary,
    auth: data.auth,
    deprecated: data.deprecated,
    change: data.change,
    params: data.params,
    request: data.request,
    responses: data.responses,
  }),
  fromAttrs: (attrs, children) => {
    const method = attrs.string("method") as HttpMethod | undefined;
    const description = children.trim();
    return {
      method: method && METHODS.has(method) ? method : "GET",
      path: attrs.string("path") ?? "",
      summary: attrs.string("summary"),
      description: description.length > 0 ? description : undefined,
      auth: attrs.string("auth"),
      deprecated: attrs.bool("deprecated"),
      change: attrs.string("change") as EndpointChange | undefined,
      params: attrs.array<EndpointParam>("params"),
      request: attrs.object<{ contentType?: string; example?: string }>("request"),
      responses: attrs.array<EndpointResponse>("responses"),
    } as EndpointData;
  },
};

const METHOD_PILL: Record<HttpMethod, string> = {
  GET: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  POST: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  PUT: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  PATCH: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  DELETE: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  HEAD: "bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300",
  OPTIONS: "bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300",
};

const LOCATION_PILL: Record<ParamLocation, string> = {
  path: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  query: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  header: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  body: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
};

function statusPill(status: string): string {
  const lead = status.trim()[0];
  if (lead === "2")
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
  if (lead === "3" || lead === "4")
    return "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300";
  if (lead === "5") return "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300";
  return "bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300";
}

export function EndpointRead({ data, blockId, children }: PlanBlockReadProps<EndpointData>) {
  const [open, setOpen] = useState(true);
  const params = data.params ?? [];
  const responses = data.responses ?? [];
  const hasBody =
    params.length > 0 ||
    responses.length > 0 ||
    Boolean(data.request?.example) ||
    Boolean(children) ||
    Boolean(data.description);

  return (
    <section
      data-plan-block-id={blockId}
      data-plan-block-type="api-endpoint"
      className="my-4 overflow-hidden rounded-xl border border-border bg-card"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => hasBody && setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left",
          hasBody && "transition-colors hover:bg-accent/40",
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
            "shrink-0 rounded-md px-2 py-1 font-mono text-xs font-bold uppercase tracking-wide",
            METHOD_PILL[data.method],
          )}
        >
          {data.method}
        </span>
        <span
          className={cn(
            "min-w-0 truncate font-mono text-sm font-semibold text-foreground",
            data.deprecated && "line-through",
          )}
        >
          {data.path}
        </span>
        {data.auth && (
          <span className="ml-auto shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {data.auth}
          </span>
        )}
      </button>
      {data.summary && (
        <div className="px-4 pb-2 text-sm text-muted-foreground">{data.summary}</div>
      )}

      {open && hasBody && (
        <div className="border-t border-border">
          {(children || data.description) && (
            <div className="prose-plan px-4 pt-3 text-sm text-foreground">
              {children ?? <p>{data.description}</p>}
            </div>
          )}

          {params.length > 0 && (
            <div className="px-4 pt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Parameters
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {params.map((param) => (
                  <div
                    key={`${param.in}-${param.name}`}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                        LOCATION_PILL[param.in],
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

          {data.request?.example && (
            <div className="px-4 pt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Request{data.request.contentType ? ` · ${data.request.contentType}` : ""}
              </div>
              <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] text-foreground">
                {data.request.example}
              </pre>
            </div>
          )}

          {responses.length > 0 && (
            <div className="px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Responses
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {responses.map((response) => (
                  <div key={`${response.status}-${response.description ?? ""}`}>
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
    </section>
  );
}

export const endpointBlock: PlanBlock<EndpointData> = {
  schema: endpointSchema,
  mdx: endpointMdx,
  Read: EndpointRead,
};
