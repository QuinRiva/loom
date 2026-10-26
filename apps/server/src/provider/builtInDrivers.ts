// loom: the fork is Pi-first — the built-in driver registry ships pi only; the other
// drivers stay imported for their usage readers (the Usage page reads every transcript).
import { AntigravityDriver } from "./Drivers/AntigravityDriver.ts";
import { ClaudeDriver } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver } from "./Drivers/CodexDriver.ts";
import { CursorDriver } from "@t3tools/provider-cursor/server";
import { GrokDriver } from "@t3tools/provider-grok/server";
import { OpenCodeDriver } from "@t3tools/provider-opencode/server";
import { MuseDriver } from "@t3tools/provider-muse/server";
import { PiDriver, type PiDriverEnv } from "@t3tools/provider-pi/server";
import type {
  AnyProviderDriver,
  ProviderUsageReaderEnv,
} from "@t3tools/provider-core/server/driver";

export type BuiltInDriversEnv = PiDriverEnv; // loom: Pi-only registry (PR-12)

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [PiDriver]; // loom: Pi-only

export type BuiltInUsageReadersEnv =
  | ProviderUsageReaderEnv<typeof ClaudeDriver>
  | ProviderUsageReaderEnv<typeof CodexDriver>
  | ProviderUsageReaderEnv<typeof GrokDriver>
  | ProviderUsageReaderEnv<typeof OpenCodeDriver>
  | ProviderUsageReaderEnv<typeof AntigravityDriver>
  | ProviderUsageReaderEnv<typeof CursorDriver>
  | ProviderUsageReaderEnv<typeof PiDriver>
  | ProviderUsageReaderEnv<typeof MuseDriver>;

/** Order matters: aggregation keeps the first duplicate record. */
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<unknown, BuiltInUsageReadersEnv> // loom: readers only; the registry above is Pi-only
> = [
  ClaudeDriver,
  CodexDriver,
  GrokDriver,
  PiDriver,
  OpenCodeDriver,
  MuseDriver,
  AntigravityDriver,
  CursorDriver,
];
