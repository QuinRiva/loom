import { createContext } from "react";

/**
 * When true, collapsible `<Details>` blocks mount their children eagerly instead
 * of lazily (mount-on-first-open). The annotation layer sets this for the rare
 * case that needs it: a persisted comment anchored inside a never-opened
 * `<Details>` must resolve as `collapsed` (badge on the closed disclosure), which
 * requires its text nodes to exist. So when the layer has pending annotation
 * comments for the file it renders eagerly; everywhere else `<Details>` stays
 * lazy (halving initial DOM on evidence-heavy documents). New annotations are
 * unaffected — you cannot select hidden text.
 */
export const PlanEagerMountContext = createContext(false);
