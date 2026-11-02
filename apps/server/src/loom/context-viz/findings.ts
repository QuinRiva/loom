/**
 * The three arithmetic rules over tool names and token counts (plans/context-viz-experiment/plan.mdx
 * §2.2), in the order the views list them. Text rules (truncation footers, repeats) are deferred.
 */
import type { LoomContextFinding, LoomContextItem } from "@t3tools/contracts";

const WRITE_TOOL_SUFFIXES = new Set(["add", "update", "rewrite", "set", "submit", "edit", "write"]);
const READ_TOOLS = new Set(["read", "read_full", "Read"]);
const ECHO_MIN_TOKENS = 2000;
const WHOLE_FILE_MIN_TOKENS = 3000;

const sum = (items: ReadonlyArray<LoomContextItem>) =>
  items.reduce((total, item) => total + item.tokens, 0);
const kilo = (tokens: number) => `${(tokens / 1000).toFixed(1)}K`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const contextFindings = (
  items: ReadonlyArray<LoomContextItem>,
  toolArgs: ReadonlyMap<string, unknown>,
): LoomContextFinding[] => {
  const results = items.filter((item) => item.kind === "tool_result" && item.tool !== null);
  const findings: LoomContextFinding[] = [];

  const writes = results.filter((item) =>
    WRITE_TOOL_SUFFIXES.has(item.tool!.split("_").at(-1)!.toLowerCase()),
  );
  const echoes = writes.filter((item) => item.tokens >= ECHO_MIN_TOKENS);
  if (echoes.length > 0) {
    // A write needs no more than the shortest reply the same tools gave in this session.
    const echoTools = new Set(echoes.map((item) => item.tool));
    const floor = Math.min(
      ...writes.filter((item) => echoTools.has(item.tool)).map((item) => item.tokens),
    );
    const tokens = sum(echoes);
    findings.push({
      rule: "write_tool_echo",
      class: "loom_tooling",
      tokens,
      avoidableTokens: tokens - floor * echoes.length,
      itemIds: echoes.map((item) => item.id),
      detail: `${plural(echoes.length, "write")} returned ${kilo(tokens / echoes.length)} tokens each on average; the shortest reply from the same ${echoTools.size === 1 ? "tool" : "tools"} was ${floor} tokens.`,
      exact: true,
    });
  }

  const called = new Set(results.map((item) => item.tool));
  const schemas = items.filter((item) => item.kind === "tool_schema" && item.inWindow);
  const unused = schemas.filter((item) => !called.has(item.tool));
  if (unused.length > 0) {
    const tokens = sum(unused);
    findings.push({
      rule: "unused_tool_schemas",
      class: "loom_tooling",
      tokens,
      avoidableTokens: tokens,
      itemIds: unused.map((item) => item.id),
      detail: `${unused.length} of ${plural(schemas.length, "tool schema")} ${unused.length === 1 ? "was" : "were"} never called in this session, ${kilo(tokens)} tokens sent on every call.`,
      exact: true,
    });
  }

  const wholeReads = results.filter((item) => {
    const args = toolArgs.get(item.id);
    return (
      READ_TOOLS.has(item.tool!) &&
      item.tokens >= WHOLE_FILE_MIN_TOKENS &&
      !(typeof args === "object" && args !== null && ("offset" in args || "limit" in args))
    );
  });
  if (wholeReads.length > 0) {
    const tokens = sum(wholeReads);
    findings.push({
      rule: "whole_file_read",
      class: "agent_guidance",
      tokens,
      avoidableTokens: tokens,
      itemIds: wholeReads.map((item) => item.id),
      detail: `${plural(wholeReads.length, "whole-file read")} with no offset or limit took ${kilo(tokens)} tokens; the largest was ${kilo(Math.max(...wholeReads.map((item) => item.tokens)))}.`,
      exact: false,
    });
  }
  return findings;
};
