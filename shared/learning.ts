// Trade review: what a CLOSED fly can be made to teach.
//
// The backlog line for this was "on close, compare outcome vs journal thesis, append lesson,
// feed into later proposals." Building it exposed why it could not be built as written: no
// thesis was ever recorded. The three closed flies all carry campaign_wall_id null and notes
// null, so there is no branch, no wall and no reasoning attached to any of them. There was
// nothing to compare an outcome against. Capturing the decision at entry is therefore the
// first half of the work, and this module is deliberately built to degrade honestly until
// that capture has had time to accumulate.
//
// The hard rule here: this module reports only what the stored record can support, and names
// what it cannot. Two properties of the data make that rule load-bearing rather than
// decorative.
//
// 1. Only the two EXTREMES of unrealized P&L are stored, never their ORDER. Fly 1 peaked at
//    +1.60x debit and troughed at -94% of maxLoss. Whether the take-profit or the stop came
//    first is unrecoverable, so "the take-profit would have fired and the trade would have
//    won" is unknowable, not merely uncertain. A counterfactual P&L here would be fabricated,
//    and it would be the most quotable number this module produced. It does not compute one.
//    Adding peakProfitAt/peakLossAt fixes this going forward; reviews of trades that predate
//    those columns say so instead of guessing.
//
// 2. Extremes are SAMPLED, not continuous. They ratchet when /api/exit-check runs, roughly
//    eight times a session. So a recorded extreme is a lower bound on the true extreme: a
//    threshold the record shows as untouched may well have been touched between samples. Every
//    threshold observation below is phrased as "the record shows", never "it did not happen".
//    (A comment in shared/schema.ts claimed this sampling was continuous and pointed at a
//    server/peakTracker.ts that does not exist. It is corrected in the same change as this.)

export type ReviewConfidence = "observed" | "boundedBelow" | "unknowable";

export interface ReviewObservation {
  /** Stable id so the UI and any future aggregation can group without matching on prose. */
  code: string;
  /** One sentence, written to be read on a phone. */
  text: string;
  confidence: ReviewConfidence;
}

export interface TradeReviewInput {
  fly: {
    id: number;
    optionType: string;
    lowerStrike: number;
    middleStrike: number;
    upperStrike: number;
    contracts: number;
    entryDebit: number;
    exitDebit: number | null;
    entryDate: string;
    exitDate: string | null;
    maxLoss: number;
    maxProfit: number;
    peakProfitPct: number | null;
    peakLossPct: number | null;
    peakProfitAt: string | null;
    peakLossAt: string | null;
    entryBranch: string | null;
    entryThesis: string | null;
    entryWall: number | null;
    entrySpot: number | null;
  };
  /** Take-profit / stop in force. Snapshotted at close where available. */
  policy: {
    takeProfitMode: string;
    takeProfitValue: number;
    stopLossPctOfMaxLoss: number;
  } | null;
}

export interface TradeReview {
  flyId: number;
  /** Dollars. Positive is a gain. */
  realizedPnl: number | null;
  /** Exit debit as a multiple of entry debit. The scale exits actually live on. */
  realizedMultiple: number | null;
  /** Best unrealized point reached, as a multiple of entry debit. */
  peakMultiple: number | null;
  observations: ReviewObservation[];
  /** Things this review could not determine, and why. Never empty for a pre-capture trade. */
  unknowns: string[];
  thesisAvailable: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Body placement the grinds branch asks for: about 2% below the week's open. Mirrors
 * GRINDS_BODY_OFFSET in server/proposal-engine.ts. Duplicated as a review-side expectation
 * rather than imported so that changing the engine's offset does not silently rewrite the
 * standard past trades were judged against.
 */
export const GRINDS_BODY_OFFSET_EXPECTED = -0.02;

/** Branch -> the side the playbook expects. breaks is the only bull branch. */
export function expectedSideForBranch(branch: string): "call" | "put" | null {
  if (branch === "breaks") return "call";
  if (branch === "rejects" || branch === "grinds") return "put";
  return null;
}

export function reviewTrade(input: TradeReviewInput): TradeReview {
  const { fly, policy } = input;
  const obs: ReviewObservation[] = [];
  const unknowns: string[] = [];

  const realizedPnl =
    fly.exitDebit === null ? null : r2((fly.exitDebit - fly.entryDebit) * 100 * fly.contracts);
  const realizedMultiple =
    fly.exitDebit === null || fly.entryDebit === 0 ? null : r2(fly.exitDebit / fly.entryDebit);

  // Peak unrealized P&L in dollars, converted onto the debit scale. peakProfitPct is a
  // fraction of maxProfit, which is the pin-at-body-at-expiry ceiling -- a scale no live exit
  // reaches, which is exactly why it is converted here rather than reported raw.
  const peakPnl =
    fly.peakProfitPct === null ? null : fly.peakProfitPct * fly.maxProfit;
  const costBasis = fly.entryDebit * 100 * fly.contracts;
  const peakMultiple =
    peakPnl === null || costBasis === 0 ? null : r2((costBasis + peakPnl) / costBasis);

  // ---- thesis presence -------------------------------------------------------------------
  const thesisAvailable = Boolean(fly.entryBranch) || Boolean(fly.entryThesis);
  if (!thesisAvailable) {
    unknowns.push(
      "No thesis recorded: this trade has no entry branch and no entry note, so its outcome " +
        "cannot be scored against an intention. It predates decision capture.",
    );
  }

  // ---- did the structure match the branch? -----------------------------------------------
  // This is the single most useful check the loop can make, because it is decidable from the
  // record alone and it catches a real, specific mistake: taking the bull structure on a bear
  // branch. It needs no sample size and no statistics.
  if (fly.entryBranch) {
    const expected = expectedSideForBranch(fly.entryBranch);
    if (expected === null) {
      obs.push({
        code: "branch_unset_at_entry",
        text: `Entered while the branch was "${fly.entryBranch}" — not one of rejects, grinds or breaks, so the structure was not held to a side.`,
        confidence: "observed",
      });
    } else if (expected !== fly.optionType) {
      obs.push({
        code: "structure_branch_mismatch",
        text: `Branch was ${fly.entryBranch}, which calls for a ${expected} fly, but a ${fly.optionType} fly was taken. The structure contradicted the thesis.`,
        confidence: "observed",
      });
    } else {
      obs.push({
        code: "structure_branch_match",
        text: `Structure matched the thesis: ${fly.entryBranch} calls for a ${expected} fly and a ${expected} fly was taken.`,
        confidence: "observed",
      });
    }
  }

  // ---- grinds body placement -------------------------------------------------------------
  if (fly.entryBranch === "grinds" && fly.entrySpot !== null && fly.entrySpot > 0) {
    const actualOffset = fly.middleStrike / fly.entrySpot - 1;
    const driftPts = r2((actualOffset - GRINDS_BODY_OFFSET_EXPECTED) * fly.entrySpot);
    obs.push({
      code: "grinds_body_offset",
      text:
        `Grinds asks for the body about ${(GRINDS_BODY_OFFSET_EXPECTED * 100).toFixed(1)}% below the open; ` +
        `the body sat ${(actualOffset * 100).toFixed(2)}% from ${fly.entrySpot}, ` +
        `${Math.abs(driftPts).toFixed(2)} points ${driftPts >= 0 ? "above" : "below"} where the playbook put it.`,
      confidence: "observed",
    });
  }

  // ---- threshold reachability ------------------------------------------------------------
  if (policy === null) {
    unknowns.push(
      "No exit policy snapshot: settings are global and mutable, so the take-profit and stop " +
        "in force when this trade closed cannot be reconstructed from the record.",
    );
  } else if (policy.takeProfitMode === "multipleOfDebit") {
    if (peakMultiple === null) {
      unknowns.push("No peak recorded, so take-profit reachability cannot be assessed.");
    } else {
      const target = policy.takeProfitValue;
      if (peakMultiple >= target) {
        obs.push({
          code: "tp_reached",
          text: `The record shows this reached ${peakMultiple.toFixed(2)}x debit against a ${target.toFixed(2)}x target, so the take-profit was reachable and was touched.`,
          confidence: "observed",
        });
        if (realizedMultiple !== null && realizedMultiple < target) {
          obs.push({
            code: "gave_back_from_peak",
            text: `It closed at ${realizedMultiple.toFixed(2)}x after touching ${peakMultiple.toFixed(2)}x — the target was hit and not taken.`,
            confidence: "observed",
          });
        }
      } else {
        obs.push({
          code: "tp_not_reached_in_record",
          text: `The record's best was ${peakMultiple.toFixed(2)}x debit, short of the ${target.toFixed(2)}x target. Extremes are sampled about 8x a session, so the target may have been touched between samples.`,
          confidence: "boundedBelow",
        });
      }
    }
  } else {
    // The percent-of-maxProfit mode. The three closed trades peaked at 4.67%, 9.38% and 8.78%
    // of maxProfit while two of them were profitable at over 2x debit -- so this mode's target
    // sits on a scale live exits do not reach, and only the stop could ever fire.
    obs.push({
      code: "tp_mode_unreachable_scale",
      text: `Take-profit was quoted as ${policy.takeProfitValue} on the maxProfit scale. Closed trades peaked between 4.7% and 9.4% of maxProfit, so a target on that scale is effectively unreachable and only the stop can fire.`,
      confidence: "observed",
    });
  }

  // ---- peak record integrity -------------------------------------------------------------
  // If the trade EXITED above its recorded peak, the exit itself proves a better point existed
  // that no sample caught. This is worth surfacing rather than smoothing over: it is direct,
  // per-trade evidence of how coarse the sampling is, and it means every "threshold not
  // reached" finding on that trade is weaker than it looks. Found in real data -- a fly closed
  // at 1.58x with a recorded peak of 1.03x.
  if (realizedMultiple !== null && peakMultiple !== null && realizedMultiple > peakMultiple) {
    obs.push({
      code: "peak_record_incomplete",
      text: `Closed at ${realizedMultiple.toFixed(2)}x, above the best recorded point of ${peakMultiple.toFixed(2)}x — so the peak record missed the path and any "not reached" finding here understates what happened.`,
      confidence: "observed",
    });
  }

  // ---- stop ------------------------------------------------------------------------------
  if (policy !== null && fly.peakLossPct !== null) {
    const stopFrac = policy.stopLossPctOfMaxLoss;
    const stopDollars = r2(stopFrac * fly.maxLoss);
    const troughDollars = r2(fly.peakLossPct * fly.maxLoss);
    if (fly.peakLossPct <= stopFrac) {
      obs.push({
        code: "stop_breached",
        text: `Drew down to $${troughDollars.toFixed(2)} (${(fly.peakLossPct * 100).toFixed(1)}% of maxLoss), through the $${stopDollars.toFixed(2)} stop.`,
        confidence: "observed",
      });
      if (realizedPnl !== null && realizedPnl < stopDollars) {
        obs.push({
          code: "closed_worse_than_stop",
          text: `It closed at $${realizedPnl.toFixed(2)}, worse than the $${stopDollars.toFixed(2)} the stop would have capped — $${Math.abs(realizedPnl - stopDollars).toFixed(2)} beyond it.`,
          confidence: "observed",
        });
      }
    } else {
      obs.push({
        code: "stop_not_breached_in_record",
        text: `Worst recorded point was $${troughDollars.toFixed(2)}, inside the $${stopDollars.toFixed(2)} stop.`,
        confidence: "boundedBelow",
      });
    }
  }

  // ---- path order ------------------------------------------------------------------------
  // Both extremes crossing their thresholds is the case where sequence decides the outcome,
  // and it is precisely the case the old record cannot answer.
  const bothCrossed =
    policy !== null &&
    peakMultiple !== null &&
    fly.peakLossPct !== null &&
    policy.takeProfitMode === "multipleOfDebit" &&
    peakMultiple >= policy.takeProfitValue &&
    fly.peakLossPct <= policy.stopLossPctOfMaxLoss;
  if (bothCrossed) {
    if (fly.peakProfitAt && fly.peakLossAt) {
      const profitFirst = fly.peakProfitAt < fly.peakLossAt;
      obs.push({
        code: "both_thresholds_ordered",
        text: `Both thresholds were crossed, and the ${profitFirst ? "take-profit" : "stop"} came first (${profitFirst ? fly.peakProfitAt : fly.peakLossAt}), so that is the one that would have fired.`,
        confidence: "observed",
      });
    } else {
      unknowns.push(
        "Both the take-profit and the stop were crossed, but the extremes carry no timestamps, " +
          "so which came first — and therefore which would have fired — is unrecoverable.",
      );
    }
  }

  return {
    flyId: fly.id,
    realizedPnl,
    realizedMultiple,
    peakMultiple,
    observations: obs,
    unknowns,
    thesisAvailable,
  };
}

/**
 * Minimum closed trades before any ACROSS-trade claim is reported.
 *
 * Set at 20 and deliberately not lower. The current book is three trades that were all opened
 * on 2026-08-27, all on the 2026-09-04 expiration, and all closed on 2026-09-02 -- one market
 * episode observed three ways, not three independent samples. A win rate computed on it would
 * read as evidence and carry none. Per-trade observations above are unaffected: they are
 * deterministic facts about a single trade and need no sample size.
 */
export const MIN_TRADES_FOR_AGGREGATE = 20;

export interface AggregateResult {
  eligible: boolean;
  closedCount: number;
  required: number;
  /** Populated only when eligible. Absent rather than zeroed, so a caller cannot read an
   *  unpopulated aggregate as a real result. */
  stats?: {
    winRate: number;
    medianRealizedMultiple: number;
    byBranch: Record<string, { n: number; netPnl: number }>;
  };
  note: string;
}

export function aggregate(reviews: TradeReview[], branches: (string | null)[]): AggregateResult {
  const n = reviews.length;
  if (n < MIN_TRADES_FOR_AGGREGATE) {
    return {
      eligible: false,
      closedCount: n,
      required: MIN_TRADES_FOR_AGGREGATE,
      note:
        `${n} closed trade${n === 1 ? "" : "s"} recorded; ${MIN_TRADES_FOR_AGGREGATE} required before ` +
        `an across-trade number is reported. Per-trade observations are still exact — it is ` +
        `win rates and branch comparisons that would be noise at this count.`,
    };
  }
  const wins = reviews.filter((r) => (r.realizedPnl ?? 0) > 0).length;
  const mults = reviews
    .map((r) => r.realizedMultiple)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
  const mid = Math.floor(mults.length / 2);
  const median =
    mults.length === 0
      ? 0
      : mults.length % 2 === 1
        ? mults[mid]
        : (mults[mid - 1] + mults[mid]) / 2;
  const byBranch: Record<string, { n: number; netPnl: number }> = {};
  reviews.forEach((r, i) => {
    const b = branches[i] ?? "unrecorded";
    if (!byBranch[b]) byBranch[b] = { n: 0, netPnl: 0 };
    byBranch[b].n += 1;
    byBranch[b].netPnl = r2(byBranch[b].netPnl + (r.realizedPnl ?? 0));
  });
  return {
    eligible: true,
    closedCount: n,
    required: MIN_TRADES_FOR_AGGREGATE,
    stats: { winRate: r2(wins / n), medianRealizedMultiple: r2(median), byBranch },
    note: `Computed across ${n} closed trades.`,
  };
}
