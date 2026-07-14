import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PiSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  piBackendLabel,
  piCatalogModels,
  piCommandsToSnapshot,
  piToolDetail,
  piToolItemPayload,
  slimPiToolPayloadData,
} from "./PiDriver.ts";
import {
  PI_TRANSIENT_PROVIDER_ERROR_RE,
  piBackendFallbackModel,
  piRunOutcome,
} from "./piTurnRetryPolicy.ts";

type ToolMessage = Parameters<typeof piToolItemPayload>[0];

const start = (toolCallId: string, toolName: string, args: Record<string, unknown>): ToolMessage =>
  ({ type: "tool_execution_start", toolCallId, toolName, args }) as ToolMessage;
const end = (toolCallId: string, toolName: string, result: unknown): ToolMessage =>
  ({ type: "tool_execution_end", toolCallId, toolName, result, isError: false }) as ToolMessage;

describe("piToolDetail", () => {
  it("prefers the command, then pattern (with path), then path, url, title", () => {
    expect(piToolDetail({ command: "git status" })).toBe("git status");
    expect(piToolDetail({ pattern: "foo", path: "src" })).toBe("foo src");
    expect(piToolDetail({ query: "how to frobnicate" })).toBe("how to frobnicate");
    expect(piToolDetail({ path: "src/a.ts", limit: 10 })).toBe("src/a.ts");
    expect(piToolDetail({ url: "https://example.com" })).toBe("https://example.com");
    expect(piToolDetail({ title: "Fix spawn fallback" })).toBe("Fix spawn fallback");
  });

  it("returns undefined for missing/blank args and truncates long commands", () => {
    expect(piToolDetail(undefined)).toBeUndefined();
    expect(piToolDetail({})).toBeUndefined();
    expect(piToolDetail({ command: "   " })).toBeUndefined();
    expect(piToolDetail({ command: `echo ${"x".repeat(500)}` })).toHaveLength(400);
  });
});

describe("piToolItemPayload", () => {
  it("correlates start args into the completed payload (bash command)", () => {
    const toolArgs = new Map<string, Record<string, unknown>>();
    const started = piToolItemPayload(start("c1", "bash", { command: "rg foo src" }), toolArgs);
    const completed = piToolItemPayload(
      end("c1", "bash", { content: [{ text: "out" }] }),
      toolArgs,
    );

    expect(completed.itemType).toBe("command_execution");
    expect(completed.status).toBe("completed");
    // start and end both carry the discriminating one-liner for the work log
    expect(started.detail).toBe("rg foo src");
    expect(completed.detail).toBe("rg foo src");
    const data = completed.data as Record<string, unknown>;
    expect(data.rawInput).toEqual({ command: "rg foo src" });
    // original result is preserved alongside the re-attached args
    expect(data.content).toEqual([{ text: "out" }]);
    // the stash is cleared once correlated, so it cannot leak across calls
    expect(toolArgs.size).toBe(0);
  });

  it("correlates the path for read and edit calls", () => {
    const toolArgs = new Map<string, Record<string, unknown>>();
    piToolItemPayload(start("r1", "read", { path: "src/a.ts" }), toolArgs);
    piToolItemPayload(start("e1", "edit", { path: "src/b.ts", edits: [] }), toolArgs);

    const readDone = piToolItemPayload(end("r1", "read", { content: [] }), toolArgs);
    const editDone = piToolItemPayload(end("e1", "edit", { content: [] }), toolArgs);

    expect(readDone.detail).toBe("src/a.ts");
    expect(editDone.detail).toBe("src/b.ts");
    expect((readDone.data as Record<string, unknown>).rawInput).toEqual({ path: "src/a.ts" });
    expect((editDone.data as Record<string, unknown>).rawInput).toEqual({
      path: "src/b.ts",
      edits: [],
    });
  });

  it("leaves the result untouched when no args were stashed", () => {
    const toolArgs = new Map<string, Record<string, unknown>>();
    const completed = piToolItemPayload(end("x", "bash", { content: [{ text: "out" }] }), toolArgs);
    expect(completed.detail).toBeUndefined();
    expect(completed.data).toEqual({ content: [{ text: "out" }] });
  });

  it("keeps the detail on update messages by falling back to the stashed args", () => {
    const toolArgs = new Map<string, Record<string, unknown>>();
    piToolItemPayload(start("u1", "bash", { command: "pnpm test" }), toolArgs);
    const updated = piToolItemPayload(
      {
        type: "tool_execution_update",
        toolCallId: "u1",
        toolName: "bash",
        partialResult: { content: [{ text: "running..." }] },
      } as ToolMessage,
      toolArgs,
    );
    expect(updated.status).toBe("inProgress");
    expect(updated.detail).toBe("pnpm test");
  });
});

describe("slimPiToolPayloadData", () => {
  it("compacts only child-result arrays at details.results", () => {
    const nestedResults = [{ messages: [{ role: "assistant", content: "keep me whole" }] }];
    const slimmed = slimPiToolPayloadData({
      threadId: ThreadId.make("thread-1"),
      attachmentsDir: "/unused",
      cache: new Map(),
      itemType: "collab_agent_tool_call",
      data: {
        details: {
          results: [
            { childThreadId: "child-1", messages: [{ role: "assistant", content: "done" }] },
          ],
          nested: { results: nestedResults },
        },
        results: nestedResults,
      },
    }) as Record<string, unknown>;

    const details = slimmed.details as Record<string, unknown>;
    expect(details.results).toEqual([
      {
        childThreadId: "child-1",
        title: undefined,
        status: undefined,
        messageCount: 1,
        tail: [{ role: "assistant", text: "done" }],
        transcriptRef: "child-1",
      },
    ]);
    expect((details.nested as Record<string, unknown>).results).toEqual(nestedResults);
    expect(slimmed.results).toEqual(nestedResults);
  });
});

describe("PI_TRANSIENT_PROVIDER_ERROR_RE", () => {
  it("matches capacity/plumbing errors that should be retried", () => {
    for (const message of [
      "529 overloaded_error: Overloaded",
      "429 Too Many Requests",
      "rate limit exceeded",
      "503 Service Unavailable",
      "500 internal error",
      "fetch failed",
      "socket hang up",
      "request timed out",
    ])
      expect(PI_TRANSIENT_PROVIDER_ERROR_RE.test(message)).toBe(true);
  });

  it("does not match user-fault errors that should fail immediately", () => {
    for (const message of [
      "401 authentication_error: invalid x-api-key",
      "400 invalid_request_error: max_tokens too large",
      "context length exceeded",
    ])
      expect(PI_TRANSIENT_PROVIDER_ERROR_RE.test(message)).toBe(false);
  });
});

describe("piBackendFallbackModel", () => {
  const catalogue = [
    "anthropic/claude-opus-4-8",
    "google-vertex-claude/claude-opus-4-8",
    "openai-codex/gpt-5.5",
  ];

  it("maps Vertex Claude to the Anthropic-direct pool for the same model", () => {
    expect(piBackendFallbackModel("google-vertex-claude/claude-opus-4-8", catalogue)).toBe(
      "anthropic/claude-opus-4-8",
    );
  });

  it("maps Anthropic-direct to the Vertex pool for the same model", () => {
    expect(piBackendFallbackModel("anthropic/claude-opus-4-8", catalogue)).toBe(
      "google-vertex-claude/claude-opus-4-8",
    );
  });

  it("returns undefined when no other backend hosts the same model", () => {
    expect(piBackendFallbackModel("openai-codex/gpt-5.5", catalogue)).toBeUndefined();
    expect(piBackendFallbackModel(undefined, catalogue)).toBeUndefined();
  });
});

describe("piRunOutcome", () => {
  it("reads the last assistant message's stopReason and errorMessage", () => {
    expect(
      piRunOutcome([
        { role: "user", content: "hi" },
        { role: "assistant", stopReason: "error", errorMessage: "529 overloaded_error" },
      ]),
    ).toEqual({ stopReason: "error", errorMessage: "529 overloaded_error" });
  });

  it("reports a clean stop and tolerates a missing assistant message", () => {
    expect(piRunOutcome([{ role: "assistant", stopReason: "stop" }])).toEqual({
      stopReason: "stop",
      errorMessage: undefined,
    });
    expect(piRunOutcome(undefined)).toEqual({ stopReason: undefined, errorMessage: undefined });
  });
});

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("piCatalogModels backend disambiguation", () => {
  const settings = decodePiSettings({});
  const model = (provider: string, id: string, name: string) => ({
    id,
    name,
    provider,
    contextWindow: 200_000,
  });

  it("suffixes only colliding display names with the backend label", () => {
    const models = piCatalogModels(
      [
        model("openai", "gpt-5.5", "GPT-5.5"),
        model("openai-codex", "gpt-5.5", "GPT-5.5"),
        model("anthropic", "claude-opus-4-8", "Claude Opus 4.8"),
        model("google-vertex-claude", "claude-opus-4-8", "Claude Opus 4.8 (Vertex)"),
      ],
      settings,
    );
    expect(models.map((entry) => [entry.slug, entry.name, entry.subProvider])).toEqual([
      // Curated shortlist entries sort first (default model, then GPT-5.5).
      ["google-vertex-claude/claude-opus-4-8", "Claude Opus 4.8 (Vertex)", "Vertex"],
      ["openai-codex/gpt-5.5", "GPT-5.5 (Codex)", "Codex"],
      ["openai/gpt-5.5", "GPT-5.5 (OpenAI)", "OpenAI"],
      // Unique names stay clean (pi already suffixes its Vertex Claude names).
      ["anthropic/claude-opus-4-8", "Claude Opus 4.8", "Anthropic"],
    ]);
  });

  it("derives regional Bedrock labels and falls back to raw provider ids", () => {
    expect(piBackendLabel("bedrock", "au.anthropic.claude-opus-4-8-v1")).toBe("Bedrock AU");
    expect(piBackendLabel("bedrock", "anthropic.claude-opus-4-8-v1")).toBe("Bedrock");
    expect(piBackendLabel("some-new-backend", "whatever")).toBe("some-new-backend");
  });
});

describe("piCommandsToSnapshot", () => {
  it("splits skills from extension/prompt commands and strips the skill: prefix", () => {
    const { slashCommands, skills } = piCommandsToSnapshot([
      {
        name: "review",
        description: "Run a review",
        source: "extension",
        sourceInfo: { path: "<ext:review>" },
      },
      { name: "summarise", source: "prompt", sourceInfo: { path: "/tmp/summarise.md" } },
      {
        name: "skill:pdf-export",
        description: "Export a PDF",
        source: "skill",
        sourceInfo: { path: "/home/user/.pi/skills/pdf-export/SKILL.md", scope: "user" },
      },
    ]);

    expect(slashCommands).toEqual([
      { name: "review", description: "Run a review" },
      { name: "summarise" },
    ]);
    expect(skills).toEqual([
      {
        name: "pdf-export",
        path: "/home/user/.pi/skills/pdf-export/SKILL.md",
        enabled: true,
        description: "Export a PDF",
        scope: "user",
      },
    ]);
  });

  it("falls back to the skill name when source metadata omits a path and drops blank names", () => {
    const { slashCommands, skills } = piCommandsToSnapshot([
      { name: "skill:local", source: "skill" },
      { name: "   ", source: "extension" },
      { name: "skill:   ", source: "skill" },
    ]);

    expect(slashCommands).toEqual([]);
    expect(skills).toEqual([{ name: "local", path: "local", enabled: true }]);
  });
});
