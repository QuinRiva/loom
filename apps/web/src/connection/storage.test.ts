import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import {
  makeCatalogBackend,
  makeCatalogStore,
  StoredThreadSnapshot,
  THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION,
} from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});

// loom: rollout recovery for the thread catch-up truncation bug. A server-side
// fix cannot recover a cache whose cursor was advanced past omitted history — the
// client will never ask for those events again — so every pre-fix (v2) thread
// entry must be retired exactly once and reloaded from an HTTP snapshot.
// See plans/2026-07-28-thread-catchup-silent-truncation.md.
describe("thread snapshot cache schema", () => {
  // Decode the same way the store does: a JSON string straight out of IndexedDB.
  const decodeStoredThread = Schema.decodeUnknownEffect(
    Schema.fromJsonString(StoredThreadSnapshot),
  );
  const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

  it.effect("rejects pre-fix v2 entries so they cold-load once", () =>
    Effect.gen(function* () {
      const v2Entry = yield* encodeUnknownJson({
        schemaVersion: 2,
        environmentId: "env-1",
        threadId: "thread-1",
        snapshot: { snapshotSequence: 42, thread: {} },
      });

      // A failed decode IS the retirement mechanism: loadThread treats it as a
      // cold cache and falls back to the authoritative HTTP snapshot.
      const result = yield* Effect.result(decodeStoredThread(v2Entry));
      expect(result._tag).toBe("Failure");
    }),
  );

  it("pins the current version so a future bump is a deliberate edit", () => {
    expect(THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION).toBe(3);
  });
});
