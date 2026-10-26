import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { PI_DEFAULT_MODEL } from "./model.ts"; // loom: pi is the fork's default provider
import { type CommandId, ProjectId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  idleCompactionPatch,
  requiredScopesForProjectMutation,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  withIdleCompaction,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

// loom: deployctl/systemd writes no continuation marker, so empty settings must resume turns.
describe("ServerSettings restart continuation", () => {
  it("defaults restart continuation on for loom deploys", () => {
    expect(decodeServerSettings({}).continueThreadsAfterServerUpdate).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.continueThreadsAfterServerUpdate).toBe(true);
  });

  it("preserves an explicit opt-out through patches and persistence", () => {
    const optOut = { continueThreadsAfterServerUpdate: false };
    expect(decodeServerSettingsPatch(optOut)).toEqual(optOut);
    expect(decodeServerSettings(optOut).continueThreadsAfterServerUpdate).toBe(false);
  });
});

// loom: upstream's limit recovery is Loom's park-and-resume, so it is on unless opted out (P3-11).
describe("ServerSettings limited-thread auto-resume", () => {
  it("defaults auto-resume on for loom", () => {
    expect(decodeServerSettings({}).autoResumeLimitedThreads).toBe(true);
    expect(decodeServerSettings({ autoResumeLimitedThreads: false }).autoResumeLimitedThreads).toBe(
      false,
    );
  });
});

// loom: quiescence graces (pull 9 Phase 3b) — 10 min for control-started turns, never for a human's.
describe("ServerSettings quiescence graces", () => {
  it("defaults to a 10-minute control grace and no human grace", () => {
    expect(decodeServerSettings({}).quiescenceGraceMs).toBe(600_000);
    expect(decodeServerSettings({}).quiescenceHumanGraceMs).toBeNull();
  });

  it("round-trips both through a patch", () => {
    const patch = { quiescenceGraceMs: 60_000, quiescenceHumanGraceMs: 3_600_000 };
    expect(decodeServerSettingsPatch(patch)).toEqual(patch);
    expect(decodeServerSettingsPatch({ quiescenceHumanGraceMs: null })).toEqual({
      quiescenceHumanGraceMs: null,
    });
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("ClientSettings context window meter", () => {
  // loom: defaults on — the meter is the only context-usage and Compact surface
  // on a Pi-only fork (upstream's resume-compaction banner is claudeAgent-only).
  it("defaults on and preserves an explicit opt-out", () => {
    expect(decodeClientSettings({}).contextWindowMeterEnabled).toBe(true);
    expect(
      decodeClientSettings({ contextWindowMeterEnabled: false }).contextWindowMeterEnabled,
    ).toBe(false);
    expect(
      decodeClientSettingsPatch({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
  });
});

// loom: DL-1408 keeps queue as the follow-up default until Carl rules.
describe("ClientSettings follow-up behavior", () => {
  it("defaults to queue and accepts either behavior", () => {
    expect(decodeClientSettings({}).followUpBehavior).toBe("queue");
    for (const followUpBehavior of ["queue", "steer"]) {
      expect(decodeClientSettings({ followUpBehavior }).followUpBehavior).toBe(followUpBehavior);
      expect(decodeClientSettingsPatch({ followUpBehavior }).followUpBehavior).toBe(
        followUpBehavior,
      );
    }
    expect(() => decodeClientSettingsPatch({ followUpBehavior: "invalid" })).toThrow();
  });
});

describe("ServerSettings text generation default", () => {
  // loom: the fork is Pi-first, so text generation defaults to pi's default
  // model rather than upstream's codex/Luna selection.
  it("defaults text generation to the pi default model", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("pi"),
      model: PI_DEFAULT_MODEL,
    });
  });
});

describe("provider enabled defaults", () => {
  // loom: Pi-first (DL-84).
  it("enables pi by default", () => {
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("pi"), config: {} }),
    ).toBe(true);
  });

  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

// loom: workstream model presets and profiles in ServerSettings.
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
          selection: { instanceId: "pi", model: "openai-codex/gpt-6-luna" },
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

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});
