import {
  OrchestrationGoalShell,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";

import { encodeShellSnapshotForCache } from "./persistence.ts";

// Generated values can hold untrimmed strings, which a decoded value never
// has. One encode and decode gives a value a client can hold; values that
// fail are dropped. Size 30 makes the generator fill optional fields.
// loom: the fork's thread shell carries ~20 more trimmed non-empty string
// fields (workstream role, goal, blockedBy, routes, ...), so almost no raw
// generated thread survived the round trip and the sample came back empty
// most runs. Trimming every generated string (and filling blanks) first keeps
// the generator's structural variety while letting values decode.
const trimStrings = (value: unknown): unknown =>
  typeof value === "string"
    ? value.trim() || "x"
    : Array.isArray(value)
      ? value.map(trimStrings)
      : value !== null &&
          typeof value === "object" &&
          Object.getPrototypeOf(value) === Object.prototype
        ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, trimStrings(entry)]))
        : value;
const sampleDecoded = <S extends Schema.Constraint>(schema: S) =>
  Effect.gen(function* () {
    const encode = Schema.encodeEffect(schema);
    const decode = Schema.decodeEffect(schema);
    const generated = yield* Arbitrary.sampleEffect(Arbitrary.schema(schema), {
      count: 1000,
      size: 30,
    });
    const decoded = yield* Effect.forEach(
      generated,
      (value) => encode(value).pipe(Effect.map(trimStrings), Effect.flatMap(decode), Effect.option), // loom: trimStrings
    );
    return Arr.getSomes(decoded);
  });
const encodeSnapshot = Schema.encodeEffect(OrchestrationShellSnapshot);

describe("encodeShellSnapshotForCache", () => {
  it.effect("matches the Schema encoding of a generated snapshot", () =>
    Effect.gen(function* () {
      const threads = yield* sampleDecoded(OrchestrationThreadShell);
      const projects = yield* sampleDecoded(OrchestrationProjectShell);
      const goals = yield* sampleDecoded(OrchestrationGoalShell); // loom: shell snapshots carry goals
      const snapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 1,
        // The generator rarely makes monogram icons, and they are the one
        // project field whose encoding differs from the decoded value.
        projects: projects.map((project, index) =>
          index % 2 === 0
            ? { ...project, projectIcon: { kind: "monogram", text: "T3", color: "blue" } }
            : project,
        ),
        threads,
        goals, // loom
        updatedAt: "2026-09-25T00:00:00.000Z",
      };

      expect(threads.length).toBeGreaterThan(0);
      expect(projects.length).toBeGreaterThan(0);
      expect(yield* encodeShellSnapshotForCache(snapshot)).toEqual(yield* encodeSnapshot(snapshot));
    }),
  );
});
