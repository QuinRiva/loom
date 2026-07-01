import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<TabsBlock>` / `<Tab>` container blocks (Wave B6) — tabbed child blocks
 * (a strip of tabs + one panel per tab). `TabsBlock` is BuilderIO's `tabs`
 * `mdxTag` (kept verbatim for wire round-trip; `Tabs` is not their tag). Ported
 * from `tabs: [{ id, label, blocks: [] }], orientation?`, expressed MDX-natively:
 * each tab's blocks are ordinary MDX *children* of a `<Tab>` slot, already
 * resolved to React nodes — no block dispatcher.
 *
 * ANNOTATION. `TabsBlock` is one block (own `data-plan-block-id`), annotatable as
 * a unit; each panel's nested blocks keep their own `data-plan-block-type` and so
 * get a distinct id from `assignBlockIds` (Wave A2, which recurses). ALL panels
 * stay mounted (inactive ones `hidden`) — not conditionally rendered — because
 * `assignBlockIds` runs once per compile, not per tab switch, so a switched-to
 * panel would otherwise have unstamped, un-annotatable blocks. Panels render
 * in-place (never portalled out), so nested-block `enclosingBlock`/`sectionFor`
 * resolve correctly.
 *
 * A11Y. WAI-ARIA tabs: `role="tablist"`/`tab`/`tabpanel`, roving `tabIndex`,
 * arrow/Home/End keyboard nav with automatic activation.
 */

export type TabsOrientation = "horizontal" | "vertical";

export interface TabsData {
  orientation?: TabsOrientation;
}

export const tabsSchema = z.object({
  orientation: z.enum(["horizontal", "vertical"]).optional(),
}) as unknown as z.ZodType<TabsData>;

export interface TabData {
  /** Tab strip label (BuilderIO's required per-tab `label`). */
  label?: string;
}

export const tabSchema = z.object({
  label: z.string().max(200).optional(),
}) as unknown as z.ZodType<TabData>;

/** A panel learns whether it is active + its a11y ids from its `TabsBlock`
 * parent (which owns the active-index state), keyed positionally so an author's
 * omitted/duplicate tab id can never mis-target a panel. */
interface TabPanelState {
  active: boolean;
  tabId: string;
  panelId: string;
}
const TabPanelContext = createContext<TabPanelState>({
  active: true,
  tabId: "",
  panelId: "",
});

/** Provides one panel's positional state, memoised so a tab switch only
 * re-renders the panels whose active flag actually flips (and keeps the linter's
 * constructed-context-value rule happy). */
function TabPanelSlot({
  active,
  tabId,
  panelId,
  children,
}: TabPanelState & { children: ReactNode }) {
  const value = useMemo(() => ({ active, tabId, panelId }), [active, tabId, panelId]);
  return <TabPanelContext.Provider value={value}>{children}</TabPanelContext.Provider>;
}

export function TabRead({ children }: PlanBlockReadProps<TabData>) {
  const { active, tabId, panelId } = useContext(TabPanelContext);
  return (
    <div
      role="tabpanel"
      id={panelId}
      aria-labelledby={tabId}
      hidden={!active}
      tabIndex={0}
      className="plan-tab-panel"
    >
      {children as ReactNode}
    </div>
  );
}

export const tabBlock: PlanBlock<TabData> = {
  schema: tabSchema,
  Read: TabRead,
  mdx: {
    tag: "Tab",
    passChildren: true,
    toAttrs: (data) => ({ label: data.label }),
    fromAttrs: (attrs) => ({ label: attrs.string("label") }) as TabData,
  },
};

/* -------------------------------------------------------------------------- */

type TabElementProps = { label?: unknown; id?: unknown };

export function TabsRead({ data, blockId, children }: PlanBlockReadProps<TabsData>) {
  const orientation: TabsOrientation = data.orientation ?? "horizontal";
  const panels = Children.toArray(children).filter(
    isValidElement,
  ) as ReactElement<TabElementProps>[];
  const baseId = useId();
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const meta = panels.map((child, i) => {
    const p = child.props;
    const label =
      (typeof p.label === "string" && p.label) ||
      (typeof p.id === "string" && p.id) ||
      `Tab ${i + 1}`;
    return { label, tabId: `${baseId}-tab-${i}`, panelId: `${baseId}-panel-${i}` };
  });

  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const [next, prev] =
      orientation === "vertical" ? ["ArrowDown", "ArrowUp"] : ["ArrowRight", "ArrowLeft"];
    const last = panels.length - 1;
    const to =
      event.key === next
        ? (from + 1) % panels.length
        : event.key === prev
          ? (from - 1 + panels.length) % panels.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (to === -1) return;
    event.preventDefault();
    setActive(to);
    tabRefs.current[to]?.focus();
  };

  return (
    <div
      data-plan-block-id={blockId}
      data-plan-block-type="tabs"
      className={cn("plan-tabs my-4", orientation === "vertical" && "plan-tabs-vertical")}
    >
      <div role="tablist" aria-orientation={orientation} className="plan-tablist">
        {meta.map((m, i) => (
          <button
            key={m.tabId}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={m.tabId}
            aria-selected={i === active}
            aria-controls={m.panelId}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={(e) => move(e, i)}
            className={cn("plan-tab", i === active && "plan-tab-active")}
          >
            {m.label}
          </button>
        ))}
      </div>
      {panels.map((child, i) => (
        <TabPanelSlot
          key={meta[i]!.panelId}
          active={i === active}
          tabId={meta[i]!.tabId}
          panelId={meta[i]!.panelId}
        >
          {child}
        </TabPanelSlot>
      ))}
    </div>
  );
}

export const tabsBlock: PlanBlock<TabsData> = {
  schema: tabsSchema,
  Read: TabsRead,
  mdx: {
    tag: "TabsBlock",
    passChildren: true,
    toAttrs: (data) => ({ orientation: data.orientation }),
    fromAttrs: (attrs) =>
      ({ orientation: attrs.string("orientation") as TabsOrientation | undefined }) as TabsData,
  },
};
