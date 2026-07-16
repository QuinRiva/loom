import { useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import {
  EMPTY_REVIEW_CHOICE,
  PlanReviewChoicesContext,
  type ReviewVerdict,
} from "../reviewChoices";

/**
 * The `<ReviewChoice>` block (§4) — per-item tri-state decision capture
 * (Accept / Reject / Discuss + note) for "default-accept, flag exceptions" over N
 * items. Reuses the question-answer channel via {@link PlanReviewChoicesContext}:
 * a decision upserts one deterministic `mdx-review:<file>:<itemId>` comment that
 * injects into the next review turn (no export step). When the context is absent
 * (bare renderer / tests) it renders read-only, exactly like `<QuestionForm>`.
 *
 * `itemId` is the aggregation key and MUST be unique per file (a duplicate would
 * collapse two widgets onto one comment) — `planLint.ts` enforces that.
 */

export interface ReviewChoiceData {
  itemId: string;
  label?: string;
  placeholder?: string;
}

export const reviewChoiceSchema = z.object({
  itemId: z.string().trim().min(1).max(120),
  label: z.string().trim().max(120).optional(),
  placeholder: z.string().trim().max(240).optional(),
}) as unknown as z.ZodType<ReviewChoiceData>;

export const reviewChoiceMdx: BlockMdxConfig<ReviewChoiceData> = {
  tag: "ReviewChoice",
  toAttrs: (data) => ({
    itemId: data.itemId,
    label: data.label,
    placeholder: data.placeholder,
  }),
  fromAttrs: (attrs) =>
    ({
      itemId: attrs.string("itemId") ?? "",
      label: attrs.string("label"),
      placeholder: attrs.string("placeholder"),
    }) as ReviewChoiceData,
};

const VERDICTS: { id: ReviewVerdict; label: string; active: string }[] = [
  { id: "accept", label: "Accept", active: "bg-emerald-500 text-white" },
  { id: "reject", label: "Reject", active: "bg-red-500 text-white" },
  { id: "discuss", label: "Discuss", active: "bg-amber-500 text-white" },
];

export function ReviewChoiceRead({ data, blockId }: PlanBlockReadProps<ReviewChoiceData>) {
  const api = useContext(PlanReviewChoicesContext);
  const sectionRef = useRef<HTMLElement>(null);
  const choice = api ? api.getChoice(data.itemId) : EMPTY_REVIEW_CHOICE;
  const label = data.label ?? data.itemId;
  const placeholder = data.placeholder ?? "Add a note…";

  const setVerdict = (verdict: ReviewVerdict) =>
    api?.setChoice(data, sectionRef.current, {
      ...choice,
      verdict: choice.verdict === verdict ? null : verdict,
    });
  const setNote = (note: string) => api?.setChoice(data, sectionRef.current, { ...choice, note });

  return (
    <section
      ref={sectionRef}
      data-plan-block-id={blockId}
      data-plan-block-type="review-choice"
      className="my-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
    >
      <span className="shrink-0 text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="flex shrink-0 divide-x divide-border overflow-hidden rounded-md border border-border">
        {VERDICTS.map((verdict) => {
          const selected = choice.verdict === verdict.id;
          const className = cn(
            "px-2.5 py-1 text-[11px] font-medium transition-colors",
            selected ? verdict.active : "text-muted-foreground",
            api && !selected && "hover:bg-muted/80",
          );
          return api ? (
            <button
              key={verdict.id}
              type="button"
              aria-pressed={selected}
              className={className}
              onClick={() => setVerdict(verdict.id)}
            >
              {verdict.label}
            </button>
          ) : (
            <span key={verdict.id} className={className}>
              {verdict.label}
            </span>
          );
        })}
      </div>
      {api ? (
        <NoteInput value={choice.note} placeholder={placeholder} onCommit={setNote} />
      ) : (
        <div className="min-w-0 flex-1 rounded-md border border-dashed border-border px-2.5 py-1 text-[11px] italic text-muted-foreground">
          {placeholder}
        </div>
      )}
    </section>
  );
}

/** Uncommitted-edit note input (mirrors `<QuestionForm>`'s WriteInAnswer): local
 * text state committed on blur/Enter so the composer chip is not rewritten per
 * keystroke; external resets (chip removal) sync back in via the effect. */
function NoteInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() !== value) onCommit(text.trim());
  };
  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      aria-label={`Note for ${placeholder}`}
      className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 py-1 text-[11px] text-foreground placeholder:italic placeholder:text-muted-foreground focus:border-ring focus:outline-none"
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

export const reviewChoiceBlock: PlanBlock<ReviewChoiceData> = {
  schema: reviewChoiceSchema,
  mdx: reviewChoiceMdx,
  Read: ReviewChoiceRead,
};
