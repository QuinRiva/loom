import { createContext } from "react";

/**
 * Mount `<Details>` children eagerly. The annotation layer sets this only when the file
 * has pending comments, since one anchored in a never-opened `<Details>` needs its text
 * nodes to resolve as `collapsed`; otherwise `<Details>` stays lazy.
 */
export const PlanEagerMountContext = createContext(false);
