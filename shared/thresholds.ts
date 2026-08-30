// Cockpit nudge thresholds — discretionary tuning, not sourced from the project wiki's
// numeric rules (the book documents *philosophy*: scale out early rather than hold for the
// rarely-realized max-profit ceiling, and a 40%-of-basis figure in its catalyst-suspension
// rule for cuts). These are set in that spirit, not lifted verbatim from a Cockpit-specific
// spec. Extracted to a shared file so both Cockpit.tsx (live nudges) and Journal.tsx
// (threshold-review against closed trades) reference the exact same regime.
export const TAKE_PROFIT_PCT = 0.25; // trigger PROFIT ZONE at 25% of max profit — pushed lower
// again (50% → 35% → 25%) per explicit user instruction, favoring locking in smaller, more
// frequent gains over holding for a ceiling the wiki itself calls "almost never fully realized."
export const STOP_LOSS_PCT = -0.4; // trigger STOP ZONE at -40% of max loss — tightened from
// -50%, closer to the book's own 40%-of-basis figure, to flag a fading fly a bit earlier.
export const GAMMA_WARNING_DTE = 3; // widened from 2 — one extra day of lead time before
// theta/gamma acceleration into the close, since this is a practice account for a new trader.
export const WING_BREACH_URGENT_DTE = 2; // widened from 1, to match the gamma warning window —
// an out-of-wing spot becomes a real (not just theoretical) risk right as gamma risk rises.
export const CAPITAL_WARN_PCT = 0.1;
export const CAPITAL_DANGER_PCT = 0.2; // unchanged — 20% aggregate risk ($200 of a $1,000
// account) is already a deliberate, documented ceiling from earlier in this project; no wiki
// signal to move it.
