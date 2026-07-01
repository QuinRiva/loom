import {
  IconArrowNarrowRight,
  IconChevronRight,
  IconDatabase,
  IconKey,
  IconLink,
} from "@tabler/icons-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<DataModel>` block — a dbdiagram / Prisma-style entity-relationship
 * diagram. Schema + MDX round-trip ported verbatim from `@agent-native/core`
 * `data-model.config.ts` (whole `entities`/`relations` arrays are JSON props).
 * The Read renderer is ported from their `DataModelBlock.tsx` (Read half only —
 * the editor half is dropped) with BuilderIO's `plan-*` theme classes swapped
 * for the app's own design tokens (foreground / muted-foreground / border /
 * card / accent). FK hover/click highlights + scrolls to the referenced entity.
 */

export type DataModelRelationKind = "1-1" | "1-n" | "n-n";
export type DataModelChange = "added" | "modified" | "removed" | "renamed";

export interface DataModelField {
  name: string;
  type?: string;
  pk?: boolean;
  fk?: string;
  nullable?: boolean;
  default?: string;
  note?: string;
  change?: DataModelChange;
  was?: string;
}

export interface DataModelEntity {
  id: string;
  name: string;
  note?: string;
  change?: DataModelChange;
  fields: DataModelField[];
}

export interface DataModelRelation {
  from: string;
  to: string;
  kind?: DataModelRelationKind;
  label?: string;
}

export interface DataModelData {
  entities: DataModelEntity[];
  relations?: DataModelRelation[];
}

const changeSchema = z.enum(["added", "modified", "removed", "renamed"]);

const fieldSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.string().trim().max(120).optional(),
  pk: z.boolean().optional(),
  fk: z.string().trim().max(200).optional(),
  nullable: z.boolean().optional(),
  default: z.string().trim().max(400).optional(),
  note: z.string().trim().max(600).optional(),
  change: changeSchema.optional(),
  was: z.string().trim().max(400).optional(),
}) as z.ZodType<DataModelField>;

const entitySchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  note: z.string().trim().max(600).optional(),
  change: changeSchema.optional(),
  fields: z.array(fieldSchema).max(80),
}) as z.ZodType<DataModelEntity>;

const relationSchema = z.object({
  from: z.string().trim().min(1).max(120),
  to: z.string().trim().min(1).max(120),
  kind: z.enum(["1-1", "1-n", "n-n"]).optional(),
  label: z.string().trim().max(160).optional(),
}) as z.ZodType<DataModelRelation>;

export const dataModelSchema = z.object({
  entities: z.array(entitySchema).min(1).max(60),
  relations: z.array(relationSchema).max(200).optional(),
}) as unknown as z.ZodType<DataModelData>;

export const dataModelMdx: BlockMdxConfig<DataModelData> = {
  tag: "DataModel",
  toAttrs: (data) => ({
    entities: data.entities,
    relations: data.relations,
  }),
  fromAttrs: (attrs) =>
    ({
      entities: attrs.array<DataModelEntity>("entities") ?? [],
      relations: attrs.array<DataModelRelation>("relations"),
    }) as DataModelData,
};

/* ── Change-chip tokens (kept from BuilderIO; theme-aware light+dark) ──────── */

const CHANGE_BADGE: Record<DataModelChange, string> = {
  added: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  modified: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  removed: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  renamed: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
};

const CHANGE_LABEL: Record<DataModelChange, string> = {
  added: "Added",
  modified: "Modified",
  removed: "Removed",
  renamed: "Renamed",
};

const CHANGE_NAME_INK: Record<DataModelChange, string> = {
  added: "text-emerald-700 dark:text-emerald-300",
  modified: "text-blue-700 dark:text-blue-300",
  removed: "text-red-600 line-through dark:text-red-300",
  renamed: "text-violet-700 dark:text-violet-300",
};

const CHANGE_ROW_ACCENT: Record<DataModelChange, string> = {
  added: "border-l-2 border-l-emerald-400 dark:border-l-emerald-500/60",
  modified: "border-l-2 border-l-blue-400 dark:border-l-blue-500/60",
  removed: "border-l-2 border-l-red-400 dark:border-l-red-500/60",
  renamed: "border-l-2 border-l-violet-400 dark:border-l-violet-500/60",
};

function ChangeChip({ change }: { change: DataModelChange }) {
  return (
    <span
      title={CHANGE_LABEL[change]}
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide",
        CHANGE_BADGE[change],
      )}
    >
      {CHANGE_LABEL[change]}
    </span>
  );
}

function parseFk(fk: string): { entity: string; field?: string | undefined } {
  const trimmed = fk.trim();
  const dot = trimmed.indexOf(".");
  if (dot === -1) return { entity: trimmed };
  return {
    entity: trimmed.slice(0, dot).trim(),
    field: trimmed.slice(dot + 1).trim() || undefined,
  };
}

function resolveEntity(entities: DataModelEntity[], ref: string): DataModelEntity | undefined {
  const needle = ref.trim();
  return (
    entities.find((entity) => entity.id === needle) ??
    entities.find((entity) => entity.name.toLowerCase() === needle.toLowerCase())
  );
}

function entityLabel(entities: DataModelEntity[], ref: string): string {
  return resolveEntity(entities, ref)?.name ?? ref;
}

function relationGlyph(kind?: DataModelRelationKind): string {
  if (kind === "1-1") return "1:1";
  if (kind === "n-n") return "n:n";
  return "1:n";
}

function effectiveRelations(data: DataModelData): DataModelRelation[] {
  if (data.relations && data.relations.length > 0) return data.relations;
  const inferred: DataModelRelation[] = [];
  for (const entity of data.entities) {
    for (const field of entity.fields) {
      if (!field.fk) continue;
      const target = resolveEntity(data.entities, parseFk(field.fk).entity);
      if (!target) continue;
      inferred.push({ from: target.id, to: entity.id, kind: "1-n", label: field.name });
    }
  }
  return inferred;
}

export function DataModelRead({ data, blockId }: PlanBlockReadProps<DataModelData>) {
  const entities = data.entities ?? [];
  const relations = useMemo(() => effectiveRelations(data), [data]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    const expandAll = entities.length <= 2;
    entities.forEach((entity, index) => {
      initial[entity.id] = expandAll || index === 0;
    });
    return initial;
  });
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const toggle = useCallback((id: string) => {
    setExpanded((current) => ({ ...current, [id]: !current[id] }));
  }, []);

  const focusEntity = useCallback((targetId: string | undefined, scroll: boolean) => {
    if (!targetId) {
      setHighlighted(null);
      return;
    }
    setHighlighted(targetId);
    if (scroll) {
      setExpanded((current) => ({ ...current, [targetId]: true }));
      cardRefs.current[targetId]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  return (
    <section data-plan-block-id={blockId} data-plan-block-type="data-model" className="my-4">
      <div className="flex flex-col gap-3">
        {entities.map((entity) => {
          const isOpen = expanded[entity.id] ?? false;
          const isHighlighted = highlighted === entity.id;
          return (
            <div
              key={entity.id}
              ref={(node) => {
                cardRefs.current[entity.id] = node;
              }}
              data-entity-id={entity.id}
              className={cn(
                "overflow-hidden rounded-xl border bg-card transition-shadow",
                isHighlighted ? "border-blue-400 ring-2 ring-blue-400/50" : "border-border",
              )}
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggle(entity.id)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-accent/60"
              >
                <IconChevronRight
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform",
                    isOpen && "rotate-90",
                  )}
                />
                <IconDatabase className="size-4 shrink-0 text-blue-600 dark:text-blue-300" />
                <span
                  className={cn(
                    "min-w-0 truncate font-mono text-sm font-semibold",
                    entity.change ? CHANGE_NAME_INK[entity.change] : "text-foreground",
                  )}
                >
                  {entity.name}
                </span>
                {entity.change && <ChangeChip change={entity.change} />}
                <span className="ml-auto shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {entity.fields.length} {entity.fields.length === 1 ? "field" : "fields"}
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-border">
                  {entity.note && (
                    <p className="px-4 pt-2 text-xs italic text-muted-foreground">{entity.note}</p>
                  )}
                  <table className="w-full border-collapse text-sm">
                    <tbody>
                      {entity.fields.map((field) => {
                        const fkTarget = field.fk
                          ? resolveEntity(entities, parseFk(field.fk).entity)
                          : undefined;
                        return (
                          <tr
                            key={field.name}
                            className={cn(
                              "border-t border-border/70 align-top first:border-t-0",
                              field.fk && "cursor-pointer hover:bg-blue-500/5",
                              field.change && CHANGE_ROW_ACCENT[field.change],
                            )}
                            onMouseEnter={
                              fkTarget ? () => focusEntity(fkTarget.id, false) : undefined
                            }
                            onMouseLeave={
                              fkTarget ? () => focusEntity(undefined, false) : undefined
                            }
                            onClick={fkTarget ? () => focusEntity(fkTarget.id, true) : undefined}
                          >
                            <td className="w-px whitespace-nowrap py-1.5 pl-4 pr-2">
                              <div className="flex items-center gap-1.5">
                                {field.pk && (
                                  <IconKey className="size-3.5 shrink-0 text-amber-500 dark:text-amber-300" />
                                )}
                                {field.fk && (
                                  <IconLink className="size-3.5 shrink-0 text-blue-500 dark:text-blue-300" />
                                )}
                                <span
                                  className={cn(
                                    "font-mono text-xs",
                                    field.pk && "font-semibold",
                                    field.change
                                      ? CHANGE_NAME_INK[field.change]
                                      : "text-foreground",
                                  )}
                                >
                                  {field.name}
                                </span>
                              </div>
                            </td>
                            <td className="py-1.5 pr-2">
                              <div className="flex flex-wrap items-center gap-1.5">
                                {field.change === "modified" && field.was && (
                                  <>
                                    <span className="inline-block rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground line-through">
                                      {field.was}
                                    </span>
                                    <IconArrowNarrowRight className="size-3 shrink-0 text-muted-foreground" />
                                  </>
                                )}
                                {field.type && (
                                  <span
                                    className={cn(
                                      "inline-block rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground",
                                      field.change === "removed" && "line-through",
                                    )}
                                  >
                                    {field.type}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="py-1.5 pr-4 text-right">
                              <div className="flex flex-wrap items-center justify-end gap-1">
                                {field.change && <ChangeChip change={field.change} />}
                                {field.pk && (
                                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-600 dark:bg-amber-500/15 dark:text-amber-300">
                                    PK
                                  </span>
                                )}
                                {field.fk && (
                                  <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
                                    FK
                                    <span className="font-mono font-normal opacity-90">
                                      {fkTarget
                                        ? `${fkTarget.name}${
                                            parseFk(field.fk).field
                                              ? `.${parseFk(field.fk).field}`
                                              : ""
                                          }`
                                        : field.fk}
                                    </span>
                                  </span>
                                )}
                                {field.nullable && (
                                  <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    nullable
                                  </span>
                                )}
                                {field.default != null && field.default !== "" && (
                                  <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                    = {field.default}
                                  </span>
                                )}
                              </div>
                              {field.note && (
                                <div className="mt-0.5 text-[11px] italic text-muted-foreground">
                                  {field.note}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {entity.fields.length === 0 && (
                        <tr>
                          <td className="px-4 py-2 text-xs text-muted-foreground">
                            No fields yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {relations.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Relations
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {relations.map((relation) => {
              const fromEntity = resolveEntity(entities, relation.from);
              const toEntity = resolveEntity(entities, relation.to);
              return (
                <button
                  key={`${relation.from}-${relation.to}-${relation.label ?? ""}`}
                  type="button"
                  className="group flex w-fit items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent/60"
                  onMouseEnter={() => focusEntity(toEntity?.id, false)}
                  onMouseLeave={() => focusEntity(undefined, false)}
                  onClick={() => focusEntity(toEntity?.id, true)}
                >
                  <span className="font-mono text-xs font-semibold text-foreground">
                    {entityLabel(entities, relation.from)}
                  </span>
                  <span className="flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">
                    {relationGlyph(relation.kind)}
                    <IconArrowNarrowRight className="size-3" />
                  </span>
                  <span className="font-mono text-xs font-semibold text-foreground">
                    {entityLabel(entities, relation.to)}
                  </span>
                  {relation.label && (
                    <span className="text-xs text-muted-foreground">· {relation.label}</span>
                  )}
                  {!fromEntity || !toEntity ? (
                    <span className="text-[10px] text-amber-600 dark:text-amber-300">
                      (unresolved)
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

export const dataModelBlock: PlanBlock<DataModelData> = {
  schema: dataModelSchema,
  mdx: dataModelMdx,
  Read: DataModelRead,
};
