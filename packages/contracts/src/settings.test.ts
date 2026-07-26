import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings sidebar v2", () => {
  it("defaults the beta off with a three-day auto-settle threshold", () => {
    const settings = decodeClientSettings({});
    expect(settings.sidebarV2Enabled).toBe(false);
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
  });

  it("allows auto-settle by inactivity to be disabled", () => {
    expect(
      decodeClientSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
    ).toBeNull();
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettings.workstreamModelPresets", () => {
  it("defaults to an empty record so configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.workstreamModelPresets).toEqual({});
    expect(decodeServerSettings({}).workstreamModelPresets).toEqual({});
  });

  it("round-trips a populated preset map keyed by plain slugs", () => {
    const decoded = decodeServerSettings({
      workstreamModelPresets: {
        reviewer: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        coder: { instanceId: "pi", model: "some-model" },
      },
    });
    expect(decoded.workstreamModelPresets.reviewer).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(decoded.workstreamModelPresets.coder).toEqual({ instanceId: "pi", model: "some-model" });
    // Legacy `{provider}` shape is absorbed by ModelSelection's pre-decode transform.
    expect(
      decodeServerSettings({
        workstreamModelPresets: { legacy: { provider: "codex", model: "gpt-5.4" } },
      }).workstreamModelPresets.legacy?.instanceId,
    ).toBe("codex");
  });
});

describe("ServerSettingsPatch.workstreamModelPresets", () => {
  it("treats workstreamModelPresets as an optional whole-map replacement", () => {
    expect(decodeServerSettingsPatch({}).workstreamModelPresets).toBeUndefined();
    const replacement = decodeServerSettingsPatch({
      workstreamModelPresets: { reviewer: { instanceId: "codex", model: "gpt-5.4" } },
    });
    expect(replacement.workstreamModelPresets?.reviewer).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
    });
  });
});

describe("ServerSettings.workstreamModelProfiles", () => {
  const fable = {
    selection: { instanceId: "pi", model: "anthropic/claude-fable-5" },
    scores: { horsepower: 8, goalOrientation: 8, thoroughness: 6, endurance: 7 },
    costPerMtok: { input: 5, output: 25 },
    agentic: "full" as const,
    unsuitableFor: ["security-sensitive" as const],
    usableContext: 200000,
    notes: "never route security/crypto/bio-adjacent work",
  };

  it("defaults to an empty record so configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.workstreamModelProfiles).toEqual({});
    expect(decodeServerSettings({}).workstreamModelProfiles).toEqual({});
  });

  it("round-trips a populated profile map with required + optional fields", () => {
    const decoded = decodeServerSettings({ workstreamModelProfiles: { "Fable 5": fable } });
    expect(decoded.workstreamModelProfiles["Fable 5"]).toEqual(fable);
  });

  it("decodes a profile that omits every documentation-only field", () => {
    const decoded = decodeServerSettings({
      workstreamModelProfiles: {
        Luna: {
          selection: { instanceId: "pi", model: "openai-codex/gpt-5.6-luna" },
          scores: { horsepower: 5, goalOrientation: 3, thoroughness: 5, endurance: 5 },
          costPerMtok: { input: 1, output: 4 },
          agentic: "bounded",
        },
      },
    });
    expect(decoded.workstreamModelProfiles.Luna?.agentic).toBe("bounded");
    expect(decoded.workstreamModelProfiles.Luna?.usableContext).toBeUndefined();
  });

  it("rejects a score outside 1..10", () => {
    expect(() =>
      decodeServerSettings({
        workstreamModelProfiles: {
          Bad: {
            selection: { instanceId: "pi", model: "x" },
            scores: { horsepower: 11, goalOrientation: 5, thoroughness: 5, endurance: 5 },
            costPerMtok: { input: 1, output: 1 },
            agentic: "full",
          },
        },
      }),
    ).toThrow();
  });

  it("treats workstreamModelProfiles as an optional whole-map replacement in a patch", () => {
    expect(decodeServerSettingsPatch({}).workstreamModelProfiles).toBeUndefined();
    const replacement = decodeServerSettingsPatch({
      workstreamModelProfiles: { "Fable 5": fable },
    });
    expect(replacement.workstreamModelProfiles?.["Fable 5"]).toEqual(fable);
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});
