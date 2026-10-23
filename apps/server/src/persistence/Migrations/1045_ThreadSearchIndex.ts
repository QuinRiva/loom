import { createThreadSearchTables } from "../threadSearchIndex.loom.ts";

/**
 * Thread content search (plans/thread-content-search): the FTS5 index and the
 * per-root embeddings table. 1062 installs the triggers and fills it.
 */
export default createThreadSearchTables;
