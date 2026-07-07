import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SearchIcon } from "lucide-react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { TooltipProvider } from "../ui/tooltip";
import { scoreModelPickerSearch } from "./modelPickerSearch";
import { cn } from "~/lib/utils";

/**
 * The shared searchable-model picker core: a search box over a
 * height-capped, virtualized, keyboard-navigable list of two-line rows.
 *
 * It is deliberately generic — rows are addressed by opaque string keys and
 * rendered by the caller via `renderRow`, and the caller owns the
 * filter+sort that turns `searchQuery` into the ordered `visibleKeys`. This
 * keeps composer-specific decoration (favourites, ⌘-number jump hints, the
 * provider sidebar) in the composer layer while both the composer model
 * picker and the settings failover pickers share the search/scroll/keyboard
 * mechanics.
 */
export function SearchableModelList(props: {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  /** Every selectable key (the combobox item registry). */
  allKeys: ReadonlyArray<string>;
  /** Ordered keys the caller's filter+sort resolved for the current query. */
  visibleKeys: ReadonlyArray<string>;
  /** The combobox value — the currently-selected key, or "" when none. */
  selectedKey: string;
  renderRow: (key: string, index: number) => ReactNode;
  onSelect: (key: string) => void;
  onRequestClose?: () => void;
  /** Optional left rail (e.g. the composer's provider sidebar). */
  sidebar?: ReactNode;
  /** Size classes for the outer picker card (height cap + width). */
  className?: string;
  placeholder?: string;
  emptyLabel?: string;
  estimatedItemSize?: number;
  /** Extra dependency for the virtualized list (e.g. favourites set). */
  extraData?: unknown;
  /** Bump to imperatively refocus the search input (e.g. after a sidebar click). */
  focusSignal?: unknown;
}) {
  const { onSearchQueryChange, onSelect, onRequestClose, renderRow, visibleKeys } = props;
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const highlightedKeyRef = useRef<string | null>(null);

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(focusSearchInput);
    const timeout = window.setTimeout(focusSearchInput, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  const { focusSignal } = props;
  useEffect(() => {
    const frame = window.requestAnimationFrame(focusSearchInput);
    return () => window.cancelAnimationFrame(frame);
  }, [focusSignal, focusSearchInput]);

  const updateScrollFades = useCallback(() => {
    const scrollElement = listRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) return;
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, []);

  useLayoutEffect(() => {
    setShowTopScrollFade(false);
    setShowBottomScrollFade(visibleKeys.length > 5);
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      updateScrollFades();
      nestedFrame = window.requestAnimationFrame(updateScrollFades);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
  }, [visibleKeys, updateScrollFades]);

  const hasSidebar = props.sidebar != null;

  return (
    <TooltipProvider delay={0}>
      <div
        className={cn(
          "relative flex flex-row overflow-hidden rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          props.className,
        )}
        data-model-picker-content="true"
      >
        {props.sidebar}
        <Combobox
          inline
          items={props.allKeys as string[]}
          filteredItems={visibleKeys as string[]}
          filter={null}
          autoHighlight
          open
          virtualized
          value={props.selectedKey}
          onItemHighlighted={(key, eventDetails) => {
            highlightedKeyRef.current = typeof key === "string" ? key : null;
            if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
              void listRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(key) => {
            if (typeof key === "string") onSelect(key);
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
              hasSidebar && "border-l",
            )}
          >
            <div className="px-4 pt-2.5">
              <div className="-translate-y-px border-b border-border/70 pb-2.5 transition-colors focus-within:border-ring">
                <ComboboxInput
                  ref={searchInputRef}
                  className="[&_input]:h-6.5 [&_input]:font-sans [&_input]:leading-6.5"
                  inputClassName="rounded-none bg-transparent text-sm"
                  placeholder={props.placeholder ?? "Search models..."}
                  showTrigger={false}
                  startAddon={
                    <SearchIcon className="-translate-x-0.5 size-4 shrink-0 text-muted-foreground/55" />
                  }
                  value={props.searchQuery}
                  onChange={(e) => onSearchQueryChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      onRequestClose?.();
                      return;
                    }
                    if (e.key === "Enter" && highlightedKeyRef.current) {
                      (
                        e as typeof e & { preventBaseUIHandler?: () => void }
                      ).preventBaseUIHandler?.();
                      e.preventDefault();
                      e.stopPropagation();
                      onSelect(highlightedKeyRef.current);
                      return;
                    }
                    e.stopPropagation();
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  size="sm"
                  unstyled
                />
              </div>
            </div>

            <div className="relative min-h-0 flex-1 overflow-hidden">
              <ComboboxListVirtualized className="model-picker-list size-full min-w-0 p-0">
                <LegendList<string>
                  ref={listRef}
                  data={visibleKeys as string[]}
                  extraData={props.extraData}
                  keyExtractor={(key) => key}
                  renderItem={({ item, index }) => <>{renderRow(item, index)}</>}
                  estimatedItemSize={props.estimatedItemSize ?? 60}
                  drawDistance={480}
                  recycleItems
                  onLayout={updateScrollFades}
                  onScroll={updateScrollFades}
                  className={cn(
                    "scrollbar-gutter-both h-full overflow-x-hidden overscroll-y-contain py-1.5 [--fade-size:1.5rem]",
                    showTopScrollFade && "mask-t-from-[calc(100%-var(--fade-size))]",
                    showBottomScrollFade && "mask-b-from-[calc(100%-var(--fade-size))]",
                  )}
                />
              </ComboboxListVirtualized>
            </div>
            <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
              {props.emptyLabel ?? "No models found"}
            </ComboboxEmpty>
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
}

export interface ModelPickerOption {
  /** Persisted value returned by `onSelect` (a pi slug or bare namespace). */
  readonly value: string;
  /** Primary (bold) line — the model / entry name. */
  readonly name: string;
  /** Secondary (muted) line — usually the slug/namespace; also search-indexed. */
  readonly secondary?: string;
  /** Group heading shown in the unfiltered view (e.g. the provider label). */
  readonly group: string;
  /** Pinned entries sort to the top and keep their group heading first. */
  readonly pinned?: boolean;
}

/**
 * Option-driven searchable picker in a popover — the high-level shared entry
 * point for call sites (e.g. the settings failover pickers) that just have a
 * flat option catalogue and a trigger. It owns the query lifecycle, the
 * name+slug fuzzy filter/sort (via the composer's shared scorer), provider
 * grouping with headings, and the two-line row rendering, so the caller is
 * only data mapping + trigger wiring. The composer keeps using the low-level
 * `SearchableModelList` directly because its rows carry favourites, jump
 * hints, and disabled reasons the generic option shape doesn't model.
 */
export function SearchableModelPopover({
  options,
  onSelect,
  trigger,
  align = "start",
  placeholder = "Search models...",
}: {
  readonly options: ReadonlyArray<ModelPickerOption>;
  readonly onSelect: (value: string) => void;
  readonly trigger: ReactElement;
  readonly align?: "start" | "center" | "end";
  readonly placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trimmed = query.trim();

  const optionByValue = useMemo(
    () => new Map(options.map((option) => [option.value, option])),
    [options],
  );
  const allKeys = useMemo(() => options.map((option) => option.value), [options]);

  // One pipeline for both states. Array#sort is stable, so equal comparanda
  // keep the caller's original (namespace-grouped) order. Unfiltered: score 0,
  // ordered by group. Searching: fuzzy score over name + slug + group.
  const visibleKeys = useMemo(
    () =>
      options
        .map((option) => ({
          option,
          score: trimmed
            ? scoreModelPickerSearch(
                {
                  name: option.name,
                  driverKind: option.group,
                  providerDisplayName: option.group,
                  ...(option.secondary ? { subProvider: option.secondary } : {}),
                },
                trimmed,
              )
            : 0,
        }))
        .filter((r): r is { option: ModelPickerOption; score: number } => r.score !== null)
        .sort((a, b) => {
          if ((a.option.pinned ?? false) !== (b.option.pinned ?? false)) {
            return a.option.pinned ? -1 : 1;
          }
          return trimmed ? a.score - b.score : a.option.group.localeCompare(b.option.group);
        })
        .map(({ option }) => option.value),
    [options, trimmed],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverPopup
        align={align}
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0]"
        viewportClassName="!overflow-hidden p-0"
      >
        <SearchableModelList
          searchQuery={query}
          onSearchQueryChange={setQuery}
          allKeys={allKeys}
          visibleKeys={visibleKeys}
          selectedKey=""
          placeholder={placeholder}
          onSelect={(value) => {
            onSelect(value);
            setOpen(false);
            setQuery("");
          }}
          onRequestClose={() => setOpen(false)}
          className="h-[60vh] max-h-96 w-[min(92vw,22rem)]"
          renderRow={(value, index) => {
            const option = optionByValue.get(value);
            if (!option) return null;
            const previous = index > 0 ? optionByValue.get(visibleKeys[index - 1]!) : undefined;
            const row = (
              <ComboboxItem
                key={value}
                hideIndicator
                index={index}
                value={value}
                contentClassName="flex w-full flex-col gap-0.5"
                className="cursor-pointer rounded-md px-2 py-1.5 data-highlighted:bg-muted/56"
              >
                <span className="truncate text-xs font-medium leading-snug text-foreground">
                  {option.name}
                </span>
                {option.secondary ? (
                  <span className="truncate text-[11px] leading-snug text-muted-foreground/70">
                    {option.secondary}
                  </span>
                ) : null}
              </ComboboxItem>
            );
            // Group headings only in the unfiltered view; searching is a flat rank.
            if (trimmed || option.group === previous?.group) return row;
            return (
              <div key={value}>
                <div
                  className={cn(
                    "mx-2 mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70",
                    index === 0 ? "mt-0" : "mt-2 border-t border-border/60 pt-1.5",
                  )}
                >
                  {option.group}
                </div>
                {row}
              </div>
            );
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}
