"use client";

import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import {
  type AccountUsageSnapshot,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ACCOUNT_USAGE_DESTRUCTIVE_PERCENT } from "@t3tools/client-runtime/accountUsage";
import {
  DEFAULT_FAILOVER_CHAINS,
  describeFailoverTarget,
  failoverNamespaceLabel,
  failoverNamespaceOf,
} from "@t3tools/shared/providerFailover";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { primaryServerProvidersAtom, useAccountUsage } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { type ModelPickerOption, SearchableModelPopover } from "../chat/SearchableModelList";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const PI_INSTANCE_ID = ProviderInstanceId.make("pi");

interface FailoverAccountRow {
  readonly key: string;
  readonly displayName: string;
  readonly state: "paused" | "exhausted" | "available";
  readonly resetsAt: string | null;
}

/** Absolute reset clock ("15:40", or "Tue 23:00" when more than a day out). */
function formatResetClock(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms) || ms <= nowMs) return null;
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return ms - nowMs > 20 * 3_600_000
    ? `${date.toLocaleDateString([], { weekday: "short" })} ${time}`
    : time;
}

function accountDisplayName(key: string, providerName: string | undefined): string {
  const driver = (providerName ?? key) as ProviderDriverKind;
  return PROVIDER_DISPLAY_NAMES[driver] ?? providerName ?? key;
}

/**
 * Per-subscription-account health for the failover card. Derived from the usage
 * telemetry the client already has (exhaustion tone + explicit `limitReached`)
 * plus the user's soft-pause list — the server health registry stays the routing
 * authority; this is a best-effort settings display. Paused accounts with no
 * live usage still surface so they can be unpaused.
 */
export function deriveFailoverAccounts(
  usage: ReadonlyArray<AccountUsageSnapshot>,
  pausedAccounts: ReadonlyArray<string>,
): ReadonlyArray<FailoverAccountRow> {
  const latest = new Map<string, AccountUsageSnapshot>();
  for (const snapshot of usage) {
    const key = snapshot.providerInstanceId ?? snapshot.providerName;
    const existing = latest.get(key);
    if (!existing || snapshot.observedAt > existing.observedAt) latest.set(key, snapshot);
  }
  const paused = new Set(pausedAccounts);
  const rows = new Map<string, FailoverAccountRow>();
  for (const [key, snapshot] of latest) {
    const exhaustedWindows = snapshot.windows.filter(
      (window) => window.usedPercent >= ACCOUNT_USAGE_DESTRUCTIVE_PERCENT,
    );
    const exhausted = snapshot.limitReached === true || exhaustedWindows.length > 0;
    const resetsAt = exhaustedWindows.reduce<string | null>(
      (soonest, window) =>
        window.resetsAt !== null && (soonest === null || window.resetsAt < soonest)
          ? window.resetsAt
          : soonest,
      null,
    );
    rows.set(key, {
      key,
      displayName: accountDisplayName(key, snapshot.providerName),
      state: paused.has(key) ? "paused" : exhausted ? "exhausted" : "available",
      resetsAt,
    });
  }
  for (const key of paused) {
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        displayName: accountDisplayName(key, undefined),
        state: "paused",
        resetsAt: null,
      });
    }
  }
  return Array.from(rows.values()).sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function ChainTargetRow({
  target,
  nameBySlug,
  isFirst,
  isLast,
  onMove,
  onRemove,
}: {
  readonly target: string;
  readonly nameBySlug: ReadonlyMap<string, string>;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5">
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
        {describeFailoverTarget(target, nameBySlug)}
      </span>
      <code className="hidden shrink-0 rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground sm:inline">
        {target}
      </code>
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="size-5 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
          disabled={isFirst}
          onClick={() => onMove(-1)}
          aria-label="Move target earlier"
        >
          <ArrowUpIcon className="size-3" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="size-5 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
          disabled={isLast}
          onClick={() => onMove(1)}
          aria-label="Move target later"
        >
          <ArrowDownIcon className="size-3" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="size-5 p-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label="Remove target"
        >
          <XIcon className="size-3" />
        </Button>
      </div>
    </div>
  );
}

function ChainSourceCard({
  source,
  targets,
  isOverridden,
  hasDefault,
  nameBySlug,
  targetOptions,
  onChange,
  onReset,
}: {
  readonly source: string;
  readonly targets: ReadonlyArray<string>;
  readonly isOverridden: boolean;
  readonly hasDefault: boolean;
  readonly nameBySlug: ReadonlyMap<string, string>;
  readonly targetOptions: ReadonlyArray<ModelPickerOption>;
  readonly onChange: (nextTargets: ReadonlyArray<string>) => void;
  readonly onReset: () => void;
}) {
  const move = (index: number, direction: -1 | 1) => {
    const next = [...targets];
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= next.length) return;
    [next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!];
    onChange(next);
  };
  const available = targetOptions.filter((option) => !targets.includes(option.value));
  return (
    <div className="space-y-2 border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <code className="truncate rounded bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
            {source}
          </code>
          {isOverridden ? (
            <Badge variant="outline" size="sm" className="shrink-0">
              Customised
            </Badge>
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground/60">Default</span>
          )}
        </div>
        {(isOverridden || !hasDefault) && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={onReset}
          >
            <RotateCcwIcon className="size-3" />
            {hasDefault ? "Reset" : "Remove"}
          </Button>
        )}
      </div>
      {targets.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/70">
          No fallback targets — exhausted turns on this source will wait for the window to reset.
        </p>
      ) : (
        <div className="space-y-1.5">
          {targets.map((target, index) => (
            <ChainTargetRow
              key={target}
              target={target}
              nameBySlug={nameBySlug}
              isFirst={index === 0}
              isLast={index === targets.length - 1}
              onMove={(direction) => move(index, direction)}
              onRemove={() => onChange(targets.filter((_, i) => i !== index))}
            />
          ))}
        </div>
      )}
      {available.length > 0 && (
        <SearchableModelPopover
          options={available}
          align="start"
          placeholder="Search fallback targets..."
          onSelect={(value) => onChange([...targets, value])}
          trigger={
            <Button
              type="button"
              variant="outline"
              className="h-7 w-full justify-start gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
              aria-label={`Add fallback target for ${source}`}
            >
              <PlusIcon className="size-3" />
              Add fallback target
            </Button>
          }
        />
      )}
    </div>
  );
}

export function FailoverSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const usage = useAccountUsage();
  const failover = settings.providerFailover;
  const nowMs = Date.now();

  const userChains = failover.chains ?? {};

  const piModels = useMemo(
    () => serverProviders.find((provider) => provider.instanceId === PI_INSTANCE_ID)?.models ?? [],
    [serverProviders],
  );
  const nameBySlug = useMemo(
    () => new Map(piModels.map((model) => [model.slug, model.name])),
    [piModels],
  );
  // Target options: every concrete pi catalogue slug (grouped by provider) plus
  // one pinned "Same model" entry per namespace (persisted as the bare namespace
  // the resolver substitutes).
  const targetOptions = useMemo<ReadonlyArray<ModelPickerOption>>(() => {
    const namespaces = [
      ...new Set(piModels.map((model) => failoverNamespaceOf(model.slug))),
    ].sort();
    return [
      ...namespaces.map((namespace) => ({
        value: namespace,
        name: `Same model · ${failoverNamespaceLabel(namespace)}`,
        // Persisted namespace shown + indexed so typing e.g. "anthropic" or
        // "google-vertex-claude" finds the synthetic entry, not just its label.
        secondary: namespace,
        group: "Same model",
        pinned: true,
      })),
      ...piModels.map((model) => ({
        value: model.slug,
        name: model.name,
        secondary: model.slug,
        group: failoverNamespaceLabel(failoverNamespaceOf(model.slug)),
      })),
    ];
  }, [piModels]);

  const sources = useMemo(
    () =>
      [...new Set([...Object.keys(DEFAULT_FAILOVER_CHAINS), ...Object.keys(userChains)])].sort(),
    [userChains],
  );
  const addableSourceOptions = useMemo<ReadonlyArray<ModelPickerOption>>(
    () =>
      piModels
        .filter((model) => !sources.includes(model.slug))
        .map((model) => ({
          value: model.slug,
          name: model.name,
          secondary: model.slug,
          group: failoverNamespaceLabel(failoverNamespaceOf(model.slug)),
        })),
    [piModels, sources],
  );

  const accounts = useMemo(
    () => deriveFailoverAccounts(usage, failover.pausedAccounts),
    [usage, failover.pausedAccounts],
  );

  // Send a complete providerFailover object (server shallow-merges anyway) so
  // the patch satisfies the Partial<UnifiedSettings> shape, whose providerFailover
  // carries the required scalar fields.
  const patchFailover = (patch: {
    enabled?: boolean;
    resumeOnReset?: boolean;
    chains?: Record<string, ReadonlyArray<string>>;
    pausedAccounts?: ReadonlyArray<string>;
  }) => updateSettings({ providerFailover: { ...failover, ...patch } });

  const writeChains = (next: Record<string, ReadonlyArray<string>>) =>
    patchFailover({ chains: next });

  const setSourceTargets = (source: string, targets: ReadonlyArray<string>) =>
    writeChains({ ...userChains, [source]: targets });

  const resetSource = (source: string) => {
    const { [source]: _omit, ...rest } = userChains;
    writeChains(rest);
  };

  const togglePause = (key: string, paused: boolean) => {
    const next = paused
      ? [...new Set([...failover.pausedAccounts, key])]
      : failover.pausedAccounts.filter((account) => account !== key);
    patchFailover({ pausedAccounts: next });
  };

  return (
    <SettingsSection title="Failover">
      <SettingsRow
        title="Cross-provider failover"
        description="When a subscription hits its limit, automatically reroute turns to a healthy model and switch back when the window resets."
        control={
          <Switch
            checked={failover.enabled}
            onCheckedChange={(checked) => patchFailover({ enabled: Boolean(checked) })}
            aria-label="Enable cross-provider failover"
          />
        }
      />
      <SettingsRow
        title="Resume stalled threads on reset"
        description="Continue threads that stalled on an exhausted provider once the limit resets."
        control={
          <Switch
            checked={failover.resumeOnReset}
            onCheckedChange={(checked) => patchFailover({ resumeOnReset: Boolean(checked) })}
            aria-label="Resume stalled threads on reset"
          />
        }
      />

      {accounts.length > 0 && (
        <div className="border-t border-border/60 px-4 py-3 sm:px-5">
          <p className="mb-2 text-xs font-medium text-foreground">Subscription accounts</p>
          <div className="space-y-1.5">
            {accounts.map((account) => {
              const reset = formatResetClock(account.resetsAt, nowMs);
              const paused = account.state === "paused";
              return (
                <div
                  key={account.key}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-xs font-medium text-foreground">
                      {account.displayName}
                    </span>
                    {paused ? (
                      <Badge variant="warning" size="sm">
                        Paused
                      </Badge>
                    ) : account.state === "exhausted" ? (
                      <span className="truncate text-[11px] text-destructive">
                        Limit reached{reset ? ` · resets ${reset}` : ""}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/70">Available</span>
                    )}
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant={paused ? "default" : "outline"}
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => togglePause(account.key, !paused)}
                  >
                    {paused ? "Unpause" : "Pause"}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="border-t border-border/60 px-4 pt-3 sm:px-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground">Fallback chains</p>
          {addableSourceOptions.length > 0 && (
            <SearchableModelPopover
              options={addableSourceOptions}
              align="end"
              placeholder="Search models..."
              onSelect={(value) => setSourceTargets(value, [])}
              trigger={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                  aria-label="Add a model-specific fallback chain"
                >
                  <PlusIcon className="size-3" />
                  Add model
                </Button>
              }
            />
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground/70">
          Ordered targets tried when the source is exhausted. "Same model" keeps the model on
          another provider's pool.
        </p>
      </div>
      {sources.map((source) => (
        <ChainSourceCard
          key={source}
          source={source}
          targets={userChains[source] ?? DEFAULT_FAILOVER_CHAINS[source] ?? []}
          isOverridden={source in userChains}
          hasDefault={source in DEFAULT_FAILOVER_CHAINS}
          nameBySlug={nameBySlug}
          targetOptions={targetOptions}
          onChange={(targets) => setSourceTargets(source, targets)}
          onReset={() => resetSource(source)}
        />
      ))}
    </SettingsSection>
  );
}
