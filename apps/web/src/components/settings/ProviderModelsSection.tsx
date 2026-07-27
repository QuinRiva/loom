"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { normalizeCustomModelSlug } from "@t3tools/shared/model";

import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import { SearchableModelList } from "../chat/SearchableModelList";
import { scoreModelPickerSearch } from "../chat/modelPickerSearch";
import { Button } from "../ui/button";
import { ComboboxItem } from "../ui/combobox";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Placeholder text for the "add a custom model" input, keyed by driver
 * kind. Mirrors the prior hardcoded switch in `SettingsPanels.tsx` so the
 * UX is unchanged — only the owning component has moved.
 */
const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "gpt-6.7-codex-ultra-preview",
  [ProviderDriverKind.make("claudeAgent")]: "claude-sonnet-5",
  [ProviderDriverKind.make("cursor")]: "claude-sonnet-4-6",
  [ProviderDriverKind.make("opencode")]: "openai/gpt-5",
};

/** Capability chips derived from the model's option descriptors. */
function capabilityLabels(model: ServerProviderModel): string[] {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const labels: string[] = [];
  if (descriptors.some((descriptor) => descriptor.id === "fastMode")) labels.push("Fast mode");
  if (descriptors.some((descriptor) => descriptor.id === "thinking")) labels.push("Thinking");
  if (
    descriptors.some(
      (descriptor) =>
        descriptor.type === "select" &&
        (descriptor.id === "reasoningEffort" ||
          descriptor.id === "effort" ||
          descriptor.id === "reasoning" ||
          descriptor.id === "variant"),
    )
  ) {
    labels.push("Reasoning");
  }
  return labels;
}

interface ProviderModelsSectionProps {
  /** Identifier used to namespace input ids within the DOM. */
  readonly instanceId: ProviderInstanceId;
  /**
   * Driver kind for slug normalization + input placeholder. `null` when
   * the section is rendered without enough provider metadata.
   */
  readonly driverKind: ProviderDriverKind | null;
  /**
   * The live model list to display. Includes both built-in (probe-reported)
   * and custom entries, distinguished by `isCustom`.
   */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * The persisted custom-model slug list for this instance. Drives dedup,
   * and is the array we hand back verbatim (with the new slug appended /
   * removed) via `onChange`.
   */
  readonly customModels: ReadonlyArray<string>;
  /** Server-returned model slugs hidden from the model picker. */
  readonly hiddenModels: ReadonlyArray<string>;
  /** Model slugs favorited for this provider instance. */
  readonly favoriteModels: ReadonlyArray<string>;
  /** Explicit user-authored model ordering for this provider instance. */
  readonly modelOrder: ReadonlyArray<string>;
  /** Allow-list of model slugs shown when `showOnlySelectedModels` is on. */
  readonly selectedModels: ReadonlyArray<string>;
  /** Allow-list mode: only `selectedModels` (plus custom) reach the picker. */
  readonly showOnlySelectedModels: boolean;
  /**
   * Commit the new custom-model list. Caller is responsible for routing the
   * write to the correct storage (legacy `settings.providers[kind]` vs.
   * `providerInstances[id].config`).
   */
  readonly onChange: (next: ReadonlyArray<string>) => void;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onSelectedModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onShowOnlySelectedModelsChange: (next: boolean) => void;
}

/**
 * Shared "Models" section rendered on both the built-in default and custom
 * provider-instance cards. Owns its own input + error local state so two
 * cards on screen don't fight over the input value.
 *
 * Catalogues run to hundreds of entries with heavily repeated display names
 * (the same model served by several backends), so the list is the same
 * searchable, virtualized component the composer picker uses, and every row
 * shows its slug + backend label — the only things that tell duplicates
 * apart. Bulk show/hide applies to whatever the current query matches, which
 * makes "hide everything except X" a two-action job.
 *
 * Validation mirrors the pre-consolidation logic in `SettingsPanels`:
 *   - empty / whitespace → "Enter a model slug."
 *   - duplicate of a non-custom (probe-reported) slug → "already built in"
 *   - exceeds `MAX_CUSTOM_MODEL_LENGTH` → length error
 *   - duplicate of an already-saved custom slug → already-saved error
 */
export function ProviderModelsSection({
  instanceId,
  driverKind,
  models,
  customModels,
  hiddenModels,
  favoriteModels,
  modelOrder,
  selectedModels,
  showOnlySelectedModels,
  onChange,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  onSelectedModelsChange,
  onShowOnlySelectedModelsChange,
}: ProviderModelsSectionProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const hiddenModelSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const selectedModelSet = useMemo(() => new Set(selectedModels), [selectedModels]);
  const favoriteModelSet = useMemo(() => new Set(favoriteModels), [favoriteModels]);
  const isSearching = searchQuery.trim().length > 0;
  const orderedModels = useMemo(() => {
    return sortModelsForProviderInstance(models, {
      favoriteModels: favoriteModelSet,
      groupFavorites: true,
      modelOrder,
    });
  }, [favoriteModelSet, modelOrder, models]);
  const modelBySlug = useMemo(
    () => new Map(orderedModels.map((model) => [model.slug, model] as const)),
    [orderedModels],
  );

  const isHiddenModel = (model: ServerProviderModel): boolean =>
    !model.isCustom &&
    (showOnlySelectedModels ? !selectedModelSet.has(model.slug) : hiddenModelSet.has(model.slug));

  const allSlugs = useMemo(() => orderedModels.map((model) => model.slug), [orderedModels]);
  // Searching ranks the whole catalogue by relevance (name, slug, backend
  // label); the unfiltered view keeps the user's curated order.
  const visibleSlugs = useMemo(() => {
    const query = searchQuery.trim();
    if (!query) return allSlugs;
    return orderedModels
      .map((model) => ({
        model,
        score: scoreModelPickerSearch(
          {
            name: model.name,
            slug: model.slug,
            ...(model.subProvider ? { subProvider: model.subProvider } : {}),
            driverKind: driverKind ?? "",
            providerDisplayName: driverKind ?? "",
          },
          query,
        ),
      }))
      .filter(
        (ranked): ranked is { model: ServerProviderModel; score: number } => ranked.score !== null,
      )
      .sort((a, b) => a.score - b.score)
      .map((ranked) => ranked.model.slug);
  }, [allSlugs, driverKind, orderedModels, searchQuery]);

  const handleAdd = () => {
    const normalized = normalizeCustomModelSlug(input);
    if (!normalized) {
      setError("Enter a model slug.");
      return;
    }
    if (models.some((model) => !model.isCustom && model.slug === normalized)) {
      setError("That model is already built in.");
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setError(`Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`);
      return;
    }
    if (customModels.includes(normalized)) {
      setError("That custom model is already saved.");
      return;
    }

    onChange([...customModels, normalized]);
    setInput("");
    setError(null);
  };

  const handleRemove = (slug: string) => {
    onChange(customModels.filter((model) => model !== slug));
    onModelOrderChange(modelOrder.filter((model) => model !== slug));
    onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
    setError(null);
  };

  // In allow-list mode the eye toggles membership of the selected set;
  // otherwise it toggles the hide-list. Either way the eye means "visible
  // in the picker".
  const handleToggleHidden = (slug: string) => {
    const model = modelBySlug.get(slug);
    if (!model || model.isCustom) return;
    if (showOnlySelectedModels) {
      onSelectedModelsChange(
        selectedModelSet.has(slug)
          ? selectedModels.filter((model) => model !== slug)
          : [...selectedModels, slug],
      );
      return;
    }
    onHiddenModelsChange(
      hiddenModelSet.has(slug)
        ? hiddenModels.filter((model) => model !== slug)
        : [...hiddenModels, slug],
    );
  };

  // Bulk curation acts on the current query's matches, so a search plus one
  // click is enough to cull a hundred-model catalogue down to what you use.
  const bulkSlugs = useMemo(
    () => visibleSlugs.filter((slug) => modelBySlug.get(slug)?.isCustom === false),
    [modelBySlug, visibleSlugs],
  );
  const handleShowAll = () => {
    if (showOnlySelectedModels) {
      onSelectedModelsChange([...new Set([...selectedModels, ...bulkSlugs])]);
      return;
    }
    const remove = new Set(bulkSlugs);
    onHiddenModelsChange(hiddenModels.filter((slug) => !remove.has(slug)));
  };
  const handleHideAll = () => {
    if (showOnlySelectedModels) {
      const remove = new Set(bulkSlugs);
      onSelectedModelsChange(selectedModels.filter((slug) => !remove.has(slug)));
      return;
    }
    onHiddenModelsChange([...new Set([...hiddenModels, ...bulkSlugs])]);
  };

  const handleToggleFavorite = (slug: string) => {
    onFavoriteModelsChange(
      favoriteModelSet.has(slug)
        ? favoriteModels.filter((model) => model !== slug)
        : [...favoriteModels, slug],
    );
  };

  const handleMove = (slug: string, direction: -1 | 1) => {
    const index = allSlugs.indexOf(slug);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= allSlugs.length) {
      return;
    }
    const next = [...allSlugs];
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onModelOrderChange(next);
  };

  const visibleCount = visibleSlugs.length;
  const pickerCount = orderedModels.filter((model) => !isHiddenModel(model)).length;

  // Identity for the virtualized list. Rows are recycled, so every input a row
  // reads has to be represented here by identity — a summary of collection
  // *lengths* would miss an equal-size curation swap or a same-slug catalogue
  // refresh and leave a mounted row showing stale eye/star state or labels.
  const rowState = useMemo(
    () => ({
      searchQuery,
      hiddenModelSet,
      selectedModelSet,
      favoriteModelSet,
      modelBySlug,
      allSlugs,
      showOnlySelectedModels,
    }),
    [
      allSlugs,
      favoriteModelSet,
      hiddenModelSet,
      modelBySlug,
      searchQuery,
      selectedModelSet,
      showOnlySelectedModels,
    ],
  );

  return (
    <div>
      <div className="text-xs font-medium text-foreground">Models</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {isSearching
            ? `${visibleCount} of ${models.length} match.`
            : `${models.length} available, ${pickerCount} in the picker.`}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            className="h-5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={handleShowAll}
          >
            {showOnlySelectedModels ? "Select" : "Show"} {isSearching ? "matches" : "all"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="h-5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={handleHideAll}
          >
            {showOnlySelectedModels ? "Deselect" : "Hide"} {isSearching ? "matches" : "all"}
          </Button>
        </div>
      </div>
      <label className="mt-2 flex cursor-pointer items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Show only selected models in the picker
        </span>
        <Switch
          checked={showOnlySelectedModels}
          onCheckedChange={(checked) => onShowOnlySelectedModelsChange(Boolean(checked))}
          aria-label="Show only selected models in the picker"
        />
      </label>

      <div className="mt-2">
        <SearchableModelList
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          allKeys={allSlugs}
          visibleKeys={visibleSlugs}
          selectedKey=""
          autoFocus={false}
          placeholder="Search models by name, slug, or backend..."
          className="h-80 w-full"
          estimatedItemSize={48}
          extraData={rowState}
          // Curation is per-action (star / arrows / eye), so activating a row
          // has nothing to commit — unlike the composer picker, where picking
          // a row is the whole point.
          onSelect={() => {}}
          renderRow={(slug, index) => {
            const model = modelBySlug.get(slug);
            if (!model) return null;
            const isHidden = isHiddenModel(model);
            const isFavorite = favoriteModelSet.has(slug);
            const secondary = [model.slug, model.subProvider, ...capabilityLabels(model)].filter(
              (value): value is string => typeof value === "string" && value.length > 0,
            );
            const orderIndex = allSlugs.indexOf(slug);
            const previousModel = modelBySlug.get(allSlugs[orderIndex - 1] ?? "");
            const nextModel = modelBySlug.get(allSlugs[orderIndex + 1] ?? "");
            // Reordering is only coherent against the curated order, so the
            // arrows stand down while a query is filtering the list.
            const canMoveUp =
              !isSearching &&
              previousModel !== undefined &&
              favoriteModelSet.has(previousModel.slug) === isFavorite;
            const canMoveDown =
              !isSearching &&
              nextModel !== undefined &&
              favoriteModelSet.has(nextModel.slug) === isFavorite;

            return (
              <ComboboxItem
                key={slug}
                hideIndicator
                index={index}
                value={slug}
                contentClassName="flex w-full items-center gap-2"
                className="group cursor-pointer rounded-md px-2 py-1.5 data-highlighted:bg-muted/56"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        "min-w-0 truncate text-xs",
                        isHidden ? "text-muted-foreground line-through" : "text-foreground/90",
                      )}
                    >
                      {model.name}
                    </span>
                    {model.isCustom ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">custom</span>
                    ) : null}
                  </div>
                  <div className="truncate text-[11px] leading-snug text-muted-foreground/70">
                    {secondary.join(" · ")}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className={cn(
                            "size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground",
                            isFavorite && "text-yellow-500 hover:text-yellow-600",
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleToggleFavorite(slug);
                          }}
                          aria-label={`${isFavorite ? "Remove" : "Add"} ${model.name} ${
                            isFavorite ? "from" : "to"
                          } favorites`}
                        />
                      }
                    >
                      <StarIcon className={cn("size-3", isFavorite && "fill-current")} />
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {isFavorite ? "Remove from favorites" : "Add to favorites"}
                    </TooltipPopup>
                  </Tooltip>
                  {isSearching ? null : (
                    <>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        disabled={!canMoveUp}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMove(slug, -1);
                        }}
                        aria-label={`Move ${model.name} up`}
                      >
                        <ArrowUpIcon className="size-3" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        disabled={!canMoveDown}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMove(slug, 1);
                        }}
                        aria-label={`Move ${model.name} down`}
                      >
                        <ArrowDownIcon className="size-3" />
                      </Button>
                    </>
                  )}
                  {model.isCustom ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                            aria-label={`Remove ${model.slug}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleRemove(slug);
                            }}
                          />
                        }
                      >
                        <XIcon className="size-3" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Remove custom model</TooltipPopup>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleToggleHidden(slug);
                            }}
                            aria-label={`${isHidden ? "Show" : "Hide"} ${model.name}`}
                          />
                        }
                      >
                        {isHidden ? (
                          <EyeIcon className="size-3" />
                        ) : (
                          <EyeOffIcon className="size-3" />
                        )}
                      </TooltipTrigger>
                      <TooltipPopup side="top">
                        {showOnlySelectedModels
                          ? isHidden
                            ? "Select for picker"
                            : "Deselect from picker"
                          : isHidden
                            ? "Show in picker"
                            : "Hide from picker"}
                      </TooltipPopup>
                    </Tooltip>
                  )}
                </div>
              </ComboboxItem>
            );
          }}
        />
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          id={`provider-instance-${instanceId}-custom-model`}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            handleAdd();
          }}
          placeholder={driverKind ? CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind] : "model-slug"}
          spellCheck={false}
        />
        <Button className="shrink-0" variant="outline" onClick={handleAdd}>
          <PlusIcon className="size-3.5" />
          Add
        </Button>
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
