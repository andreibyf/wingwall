// Canonical campaign-wall selection, shared by the client and the server.
//
// The campaign_walls table has no unique constraint on (symbol, week_of), and it cannot
// safely get one retroactively while duplicate rows already exist in the live Render
// database. So "one weekly wall key per symbol" is a convention, not an invariant, and a
// double submit, a second browser tab, or a mid-week re-key typed as a new row all leave
// two rows describing the same week.
//
// Duplicates are dangerous here for the same reason a below-spot wall is: they do not
// produce an error, they produce a plausible wrong answer. Each reader picked its own
// winner:
//
//   - Campaign.tsx used `walls.find(...)` over a list ordered by created_at DESC, so it
//     edited the row with the newest created_at STRING (created_at is app-written text,
//     not a DB clock).
//   - copilot.ts and auto-trade.ts sort by weekOf then `b.id - a.id`, so they read the
//     highest id.
//
// Those two rules disagree whenever created_at ordering and id ordering disagree, which is
// exactly what a clock skew or a hand-edited row produces. The operator would then be
// editing the branch on one row while the proposal engine traded the branch on another,
// with the UI showing the edit saved successfully.
//
// This module makes the highest id the single canonical rule -- ids are monotonic and
// assigned by the database, so the newest row always wins and no writer can influence the
// tie-break. Every reader imports from here instead of re-deriving it.

export type WallLike = {
  id: number;
  symbol: string;
  weekOf: string;
};

/**
 * The row that governs a given symbol + week: the highest id among the matches.
 * Returns undefined when that week has never been keyed for that symbol.
 */
export function canonicalWall<T extends WallLike>(
  walls: readonly T[],
  symbol: string,
  weekOf: string,
): T | undefined {
  let winner: T | undefined;
  for (const w of walls) {
    if (w.symbol !== symbol || w.weekOf !== weekOf) continue;
    if (!winner || w.id > winner.id) winner = w;
  }
  return winner;
}

/**
 * The rows that are shadowed by the canonical one for a symbol + week: everything except
 * the winner, newest first. Empty when there is no duplication.
 */
export function shadowedWalls<T extends WallLike>(
  walls: readonly T[],
  symbol: string,
  weekOf: string,
): T[] {
  const winner = canonicalWall(walls, symbol, weekOf);
  if (!winner) return [];
  return walls
    .filter((w) => w.symbol === symbol && w.weekOf === weekOf && w.id !== winner.id)
    .sort((a, b) => b.id - a.id);
}

export type DuplicateWallGroup<T extends WallLike> = {
  symbol: string;
  weekOf: string;
  /** Every row for this symbol + week, highest id first. */
  rows: T[];
  /** The row the engine currently reads. */
  canonical: T;
  /** The rows the engine currently ignores. */
  shadowed: T[];
};

/**
 * Every symbol + week that has more than one row, newest week first. This is the input to
 * the Campaign page's resolve-duplicates panel: if it is empty there is nothing to warn
 * about, and the panel stays hidden rather than reassuring the operator about a check that
 * only ever passes.
 */
export function duplicateWallGroups<T extends WallLike>(
  walls: readonly T[],
): DuplicateWallGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const w of walls) {
    const key = `${w.symbol}\u0000${w.weekOf}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(w);
    else byKey.set(key, [w]);
  }

  const groups: DuplicateWallGroup<T>[] = [];
  // Array.from rather than iterating the Map directly: the tsconfig here has no explicit
  // target, so downlevel iteration of a Map iterator does not compile.
  for (const rows of Array.from(byKey.values())) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => b.id - a.id);
    groups.push({
      symbol: sorted[0].symbol,
      weekOf: sorted[0].weekOf,
      rows: sorted,
      canonical: sorted[0],
      shadowed: sorted.slice(1),
    });
  }

  return groups.sort(
    (a, b) => b.weekOf.localeCompare(a.weekOf) || a.symbol.localeCompare(b.symbol),
  );
}
