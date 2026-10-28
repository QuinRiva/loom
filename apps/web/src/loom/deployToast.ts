import type { EnvironmentId, LoomDeployChange, LoomDeployNotice } from "@t3tools/contracts";

/** A brand-new browser profile is not greeted by last week's deploy. */
const NOTICE_MAX_AGE_MS = 24 * 60 * 60_000;
/** Rows the list shows before "See all": every noticeable row, then behind-the-scenes filler. */
const DEPLOY_LIST_ROWS = 8;

export const deployNoticeSeenKey = (environmentId: EnvironmentId) =>
  `loom.deployNotice.seen:${environmentId}`;

/**
 * Whether to show `notice` now. Marks it seen before the toast exists, so a reload while it is
 * up, or a flapping start's reconnects, never show it twice.
 */
export function claimDeployNotice(
  storage: Pick<Storage, "getItem" | "setItem">,
  environmentId: EnvironmentId,
  notice: LoomDeployNotice,
  nowMs: number,
): boolean {
  const key = deployNoticeSeenKey(environmentId);
  if (storage.getItem(key) === notice.id) return false;
  storage.setItem(key, notice.id);
  return nowMs - Date.parse(notice.at) <= NOTICE_MAX_AGE_MS;
}

const NOTICEABLE = "You'll notice";

/**
 * The list's sections, trimmed unless `showAll`: every noticeable row, then the rest up to
 * {@link DEPLOY_LIST_ROWS} in total. With no classification (summaries failed) everything sits
 * under one heading; an unclassified row among classified ones is listed as noticeable.
 */
export function deployListView(changes: ReadonlyArray<LoomDeployChange>, showAll: boolean) {
  const sections = changes.every((change) => change.kind === null)
    ? [{ heading: "In this update", changes }]
    : [
        { heading: NOTICEABLE, changes: changes.filter((change) => change.kind !== "behind") },
        {
          heading: "Behind the scenes",
          changes: changes.filter((change) => change.kind === "behind"),
        },
      ].filter((section) => section.changes.length > 0);
  let budget = DEPLOY_LIST_ROWS;
  const shown = sections.map((section) => {
    const count =
      showAll || section.heading === NOTICEABLE
        ? section.changes.length
        : Math.min(budget, section.changes.length);
    budget = Math.max(0, budget - count);
    return { heading: section.heading, changes: section.changes.slice(0, count) };
  });
  const hidden = changes.length - shown.reduce((sum, section) => sum + section.changes.length, 0);
  return { sections: shown.filter((section) => section.changes.length > 0), hidden };
}

/** The all-behind case closes on its own; anything noticeable, or unknown, stays. */
export const deployNoticeIsQuiet = (changes: ReadonlyArray<LoomDeployChange>) =>
  changes.every((change) => change.kind === "behind");
