import type { CampaignWall } from "@shared/schema";

export interface WallSelection {
  /** The wall to use for this symbol and week, or undefined when the week is unkeyed. */
  wall: CampaignWall | undefined;
  /**
   * Extra walls found for the same symbol and week, newest first, EXCLUDING the selected one.
   * Non-empty means the data is ambiguous and the operator should be told rather than having one
   * row picked silently on their behalf.
   */
  duplicates: CampaignWall[];
}

/**
 * Pick the wall for a symbol and week.
 *
 * Two pages read this (Campaign to decide whether saving updates or inserts, Builder to stamp the
 * thesis onto a trade), and they MUST agree. They previously each called `.find()` on the list,
 * which returns whichever row the API happened to order first -- so a duplicated week could have
 * had the Builder recording one branch while the Campaign page displayed another, with nothing
 * on screen to reveal the disagreement.
 *
 * Selection is by HIGHEST id: the most recently inserted row for that week. Re-keying a week is a
 * real workflow, so when several rows exist the newest is the best guess at intent. It is only a
 * guess, which is why the others are returned rather than discarded -- the caller is expected to
 * surface them. Nothing here deletes or merges anything; a duplicate may carry notes that only
 * the operator can judge.
 */
export function selectWallForWeek(
  walls: CampaignWall[] | undefined,
  symbol: string,
  weekOf: string
): WallSelection {
  const matches = (walls ?? [])
    .filter((w) => w.symbol === symbol && w.weekOf === weekOf)
    .sort((a, b) => b.id - a.id);
  return { wall: matches[0], duplicates: matches.slice(1) };
}
