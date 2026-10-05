// Settings → General → Thread search (plans/thread-content-search): which
// embedder ranks content search by meaning (server-scoped, written as a whole
// `threadSearchEmbedding` value; the server re-embeds on change), and whether
// search includes archived threads (per-device client setting).
import { ThreadSearchEmbeddingSettings } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { type ComponentProps, useState } from "react";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type Provider = ThreadSearchEmbeddingSettings["provider"];
type Draft = { readonly provider: Provider } & Readonly<Record<string, string | number>>;

const isEmbeddingSettings = Schema.is(ThreadSearchEmbeddingSettings);
const DEFAULT_EMBEDDING = DEFAULT_UNIFIED_SETTINGS.threadSearchEmbedding;

const PROVIDERS: Record<
  Provider,
  {
    readonly label: string;
    readonly initial: Draft;
    readonly fields: ReadonlyArray<{ key: string; label: string; hint?: string }>;
  }
> = {
  none: { label: "None", initial: { provider: "none" }, fields: [] },
  local: {
    label: "Local",
    initial: DEFAULT_EMBEDDING as Draft,
    fields: [{ key: "model", label: "Model" }],
  },
  "openai-compatible": {
    label: "OpenAI-compatible",
    initial: {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dim: 1536,
    },
    fields: [
      { key: "baseUrl", label: "Base URL" },
      { key: "model", label: "Model" },
      { key: "dim", label: "Dimensions" },
    ],
  },
  vertex: {
    label: "Vertex AI",
    initial: {
      provider: "vertex",
      project: "",
      location: "australia-southeast1",
      model: "gemini-embedding-001",
    },
    fields: [
      { key: "project", label: "Project" },
      {
        key: "location",
        label: "Location",
        hint: "gemini-embedding-2 is only served from global.",
      },
      { key: "model", label: "Model" },
    ],
  },
};

export function ThreadSearchSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const saved = settings.threadSearchEmbedding;
  return (
    <SettingsSection id="thread-search" title="Thread search">
      {/* Remount on every saved change so a pending draft never outlives its save. */}
      <EmbeddingRow key={JSON.stringify(saved)} saved={saved} />
      <SettingsRow
        {...searchableSetting("thread-search-include-archived")}
        description="Show archived threads in sidebar and command palette search."
        resetAction={
          settings.threadSearchIncludeArchived ? null : (
            <SettingResetButton
              label="include archived threads"
              onClick={() => updateSettings({ threadSearchIncludeArchived: true })}
            />
          )
        }
        control={
          <Switch
            checked={settings.threadSearchIncludeArchived}
            onCheckedChange={(checked) =>
              updateSettings({ threadSearchIncludeArchived: Boolean(checked) })
            }
            aria-label="Include archived threads in search results"
          />
        }
      />
    </SettingsSection>
  );
}

function EmbeddingRow({ saved }: { saved: ThreadSearchEmbeddingSettings }) {
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["threadSearchEmbedding"]);
  const { scope } = useSettingsScope();
  // The server redacts the key; never echo the placeholder back. Omitting it
  // keeps the stored key, so only a newly typed key enters a patch.
  const { apiKey: redactedKey, ...savedFields } = saved as Draft & { apiKey?: string };
  const [draft, setDraft] = useState<Draft | null>(null);
  const shown = draft ?? savedFields;
  const commit = (next: Draft) => {
    setDraft(next);
    if (isEmbeddingSettings(next)) updateSettings({ threadSearchEmbedding: next });
  };
  const input = (field: string, props: ComponentProps<typeof Input>) => (
    <Input
      size="sm"
      autoCapitalize="off"
      autoComplete="off"
      spellCheck={false}
      onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      onBlur={(event) => {
        const raw = event.currentTarget.value.trim();
        const value = field === "dim" ? Number(raw) : raw;
        if (field === "apiKey" ? raw !== "" : value !== shown[field])
          commit({ ...shown, [field]: value });
      }}
      {...props}
    />
  );
  return (
    <SettingsRow
      serverScoped
      settingKeys={["threadSearchEmbedding"]}
      {...searchableSetting("thread-search-embedding")}
      description="Ranks thread search results by meaning. None = word search only."
      status={
        draft !== null && !isEmbeddingSettings(draft)
          ? "Not saved until every field is filled in."
          : null
      }
      resetAction={
        JSON.stringify(saved) === JSON.stringify(DEFAULT_EMBEDDING) ? null : (
          <SettingResetButton
            label="thread search ranking"
            onClick={() => updateSettings({ threadSearchEmbedding: DEFAULT_EMBEDDING })}
          />
        )
      }
      control={
        <Select
          value={mixed ? null : shown.provider}
          onValueChange={(provider) => provider && commit(PROVIDERS[provider as Provider].initial)}
        >
          <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Embedding provider">
            <SelectValue>
              {(value: Provider | null) => (value === null ? "Mixed" : PROVIDERS[value].label)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(Object.keys(PROVIDERS) as Provider[]).map((provider) => (
              <SelectItem key={provider} hideIndicator value={provider}>
                {PROVIDERS[provider].label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    >
      {mixed ||
      shown.provider === "none" ||
      scope.kind === "project" ||
      scope.kind === "checkout" ? null : (
        // Keyed by provider: the inputs are uncontrolled, so a shared field key
        // (`model`) would keep the previous provider's value on screen.
        <div key={shown.provider} className="mt-3 grid max-w-2xl gap-3 pb-3.5 sm:grid-cols-2">
          {PROVIDERS[shown.provider].fields.map(({ key, label, hint }) => (
            <label key={key} className="space-y-1 text-xs text-muted-foreground">
              <span>{label}</span>
              {input(key, {
                defaultValue: String(shown[key] ?? ""),
                type: key === "dim" ? "number" : "text",
                "aria-label": label,
              })}
              {hint ? <span className="block">{hint}</span> : null}
            </label>
          ))}
          {shown.provider === "openai-compatible" ? (
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>API key</span>
              {input("apiKey", {
                type: "password",
                placeholder: redactedKey ? "Key set (type to replace)" : "Optional",
                "aria-label": "API key",
              })}
            </label>
          ) : null}
        </div>
      )}
    </SettingsRow>
  );
}
