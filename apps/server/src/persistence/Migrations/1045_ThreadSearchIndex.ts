import { createThreadSearchIndex } from "../threadSearchIndex.loom.ts";

/**
 * Thread content search (plans/thread-content-search): the FTS5 index with its
 * triggers and backfill (including workstream report files), and the empty
 * per-root embeddings table the background sweep fills.
 */
export default createThreadSearchIndex;
