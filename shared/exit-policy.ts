// Single source of truth for exit thresholds.
//
// Before this file the take-profit and stop-loss numbers existed in four independent
// places: shared/thresholds.ts, a duplicate pair of constants in server/copilot.ts that
// did not import the shared file, prose inside the copilot system prompt, and prose inside
// the threshold-watch job. A one-line tuning change meant four edits, and missing one left
// the cockpit, the copilot and the automation disagreeing about when to exit.
//
// Everything now resolves through resolveExitPolicy() against the settings row.

export type TakeProfitMode = "multipleOfDebit" | "pctOfMaxProfit";

export interface ExitPolicyInput {
  takeProfitMode: string;
  takeProfitValue: number;
  stopLossPctOfMaxLoss: number;
}

export interface ExitPolicy {
  takeProfitMode: TakeProfitMode;
  takeProfitValue: number;
  stopLossPctOfMaxLoss: number;
  describeTakeProfit: string;
  describeStopLoss: string;
}

export function resolveExitPolicy(input: ExitPolicyInput): ExitPolicy {
  const mode: TakeProfitMode =
    input.takeProfitMode === "pctOfMaxProfit" ? "pctOfMaxProfit" : "multipleOfDebit";
  // Guard the sign so a stop entered as a positive number cannot invert the comparison and
  // turn the stop-loss into a condition that fires on a winning position.
  const stop = -Math.abs(input.stopLossPctOfMaxLoss);
  return {
    takeProfitMode: mode,
    takeProfitValue: input.takeProfitValue,
    stopLossPctOfMaxLoss: stop,
    describeTakeProfit:
      mode === "multipleOfDebit"
        ? `exit at ${input.takeProfitValue}x the entry debit (+${round(input.takeProfitValue - 1, 2)}R)`
        : `exit at ${round(input.takeProfitValue * 100, 1)}% of max profit`,
    describeStopLoss: `exit at ${round(stop * 100, 1)}% of max loss (${round(stop, 2)}R)`,
  };
}

export interface ThresholdReachability {
  // The per-share exit debit each threshold demands.
  takeProfitExitDebit: number;
  stopLossExitDebit: number;
  // Expressed as a multiple of what was paid -- the number that makes an unreachable
  // target obvious at a glance.
  takeProfitAsMultipleOfDebit: number;
  takeProfitDollars: number;
  stopLossDollars: number;
  // A pctOfMaxProfit target on a cheap far-body fly can demand several times the debit.
  // Flagged rather than left for a reader to divide, because the model consuming this
  // snapshot cannot run arithmetic.
  takeProfitIsUnreachable: boolean;
  unreachableReason: string | null;
  // Set when the recorded best excursion never approached the target.
  bestEverPctOfTarget: number | null;
  note: string;
}

// A target needing more than this multiple of the debit is treated as decorative: it
// implies the underlying travels essentially all the way to the body with time left, which
// is not the scale-out behaviour the playbook describes.
export const UNREACHABLE_DEBIT_MULTIPLE = 3.0;

export function assessThresholdReachability(
  policy: ExitPolicy,
  entryDebit: number,
  maxProfitDollars: number,
  maxLossDollars: number,
  contracts: number,
  multiplier = 100,
  peakProfitPct?: number | null
): ThresholdReachability {
  const perContract = multiplier * Math.max(contracts, 1);

  let tpExit: number;
  let tpDollars: number;
  if (policy.takeProfitMode === "multipleOfDebit") {
    tpExit = entryDebit * policy.takeProfitValue;
    tpDollars = (tpExit - entryDebit) * perContract;
  } else {
    tpDollars = policy.takeProfitValue * maxProfitDollars;
    tpExit = entryDebit + tpDollars / perContract;
  }

  const slDollars = policy.stopLossPctOfMaxLoss * maxLossDollars;
  const slExit = entryDebit + slDollars / perContract;

  const multipleNeeded = entryDebit > 0 ? tpExit / entryDebit : Infinity;
  const unreachable = multipleNeeded > UNREACHABLE_DEBIT_MULTIPLE;

  // Compare the target against the best excursion actually recorded for this position,
  // when the peak tracker has sampled one.
  let bestEverPctOfTarget: number | null = null;
  if (peakProfitPct != null && maxProfitDollars > 0 && tpDollars > 0) {
    bestEverPctOfTarget = round((peakProfitPct * maxProfitDollars) / tpDollars, 4);
  }

  return {
    takeProfitExitDebit: round(tpExit, 2),
    stopLossExitDebit: round(Math.max(slExit, 0), 2),
    takeProfitAsMultipleOfDebit: round(multipleNeeded, 2),
    takeProfitDollars: round(tpDollars, 2),
    stopLossDollars: round(slDollars, 2),
    takeProfitIsUnreachable: unreachable,
    unreachableReason: unreachable
      ? `The take-profit target needs an exit debit of $${round(tpExit, 2)}, which is ` +
        `${round(multipleNeeded, 2)}x the $${round(entryDebit, 2)} paid. On a fly this cheap ` +
        `relative to its wing width that effectively never fills, so the stop can fire while ` +
        `the target cannot -- the automation would only ever cut losers.`
      : null,
    bestEverPctOfTarget,
    note:
      `Take-profit ${policy.describeTakeProfit} -> exit debit $${round(tpExit, 2)} ` +
      `(${round(multipleNeeded, 2)}x paid, $${round(tpDollars, 2)}). ` +
      `Stop ${policy.describeStopLoss} -> exit debit $${round(Math.max(slExit, 0), 2)} ` +
      `($${round(slDollars, 2)}). These are computed, not derived by the model.`,
  };
}

function round(n: number, dp: number): number {
  if (!isFinite(n)) return n;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}
