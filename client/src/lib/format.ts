export function fmtUsd(n: number | null | undefined, opts?: { signed?: boolean }): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = opts?.signed && n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })}`;
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtR(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}R`;
}

/**
 * The calendar date in America/New_York, as y/m/d parts plus day-of-week.
 *
 * Everything in this desk is keyed to the US market session, but the browser's Date reports UTC
 * through its getUTC* accessors and the local zone through the others. Mixing the two is what
 * produced the bugs below, so the timezone is named explicitly here exactly once and the rest of
 * the date logic is pure calendar arithmetic on the parts.
 */
function etParts(d: Date = new Date()): { year: number; month: number; day: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    dow: DOW[get("weekday")] ?? 1,
  };
}

/** Format y/m/d parts as YYYY-MM-DD. No Date involved, so no zone can shift it. */
function isoFromParts(year: number, month: number, day: number): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${year}-${p2(month)}-${p2(day)}`;
}

/**
 * The Monday that identifies the campaign week, in America/New_York.
 *
 * Two corrections over the previous implementation, both of which caused the week lookup to miss
 * the keyed wall and silently fall through to "no wall for this week":
 *
 * 1. WEEKENDS ROLL FORWARD. Monday-Friday resolve to that week's Monday, as before. Saturday and
 *    Sunday now resolve to the UPCOMING Monday rather than the one just past. On a Sunday the
 *    operator is preparing the week ahead -- the old behaviour returned the Monday of the week
 *    that had already finished, so a wall keyed for the coming week was invisible on the day it
 *    was most likely to be keyed. Note this deliberately changes what the Campaign page and its
 *    checklist show on a weekend; it is the same shift and the same reason.
 *
 * 2. THE ZONE IS EXPLICIT. The old version called getUTCDay/getUTCDate on a local Date. After
 *    8pm ET the UTC date is already tomorrow, so any evening between 8pm and midnight was
 *    attributed to the next UTC day -- and on a Friday evening that crossed into Saturday UTC,
 *    which under rule 1 would have jumped a whole week forward while it was still Friday for the
 *    operator. Resolving in ET first removes the entire class of error.
 *
 * The scheduled jobs compute their own Monday in Python and only ever run Monday-Friday, so they
 * never observed the weekend behaviour and this stays consistent with them.
 */
export function weekOfMonday(d: Date = new Date()): string {
  const { year, month, day, dow } = etParts(d);
  const shift = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow;
  // Pure calendar arithmetic in UTC on already-resolved ET parts: this crosses month and year
  // boundaries correctly and cannot be perturbed by a DST transition, because no wall-clock time
  // is involved -- only a count of days.
  const t = Date.UTC(year, month - 1, day) + shift * 86400000;
  const shifted = new Date(t);
  return isoFromParts(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate()
  );
}

/**
 * Today's date in America/New_York.
 *
 * Previously `new Date().toISOString().slice(0, 10)`, which is the UTC date: every entry logged
 * after 8pm ET was stamped with the NEXT day. That value is written to a fly's entryDate, so the
 * error landed in the trade record itself and then into the review that reads it.
 */
export function todayIso(): string {
  const { year, month, day } = etParts();
  return isoFromParts(year, month, day);
}
