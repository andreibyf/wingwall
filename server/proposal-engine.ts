// Deterministic butterfly construction.
//
// This module picks the body, the wings and the lot size. The language model does not,
// and must not: those numbers define the risk on every position, and a model that could
// not work out a day of the week is not going to be trusted to divide a risk budget by a
// debit. The model's job downstream is to approve or decline a finished proposal and write
// the rationale -- a veto, not a calculator.
//
// Every rejection carries a reason string. A proposal that cannot be built has to explain
// itself, because "no trade today" is only useful if the operator can see whether the
// chain was unsuitable or the code simply failed to find quotes.

import type { ChainData, ChainOption } from "./chain-analysis";
import type { ChainAnalysis } from "./chain-analysis";
import { deriveFlyEconomics, getMultiplier } from "../shared/flyMath";
import {
  assessThresholdReachability,
  type ExitPolicy,
  type ThresholdReachability,
} from "../shared/exit-policy";

export interface ProposalSettings {
  accountBalance: number;
  riskPerTradePercent: number;
  targetDebitToWidth: number;
  maxDebitToWidth: number;
}

export interface WingCandidate {
  width: number;
  lowerStrike: number;
  upperStrike: number;
  debit: number;
  debitToWidth: number;
  maxLossPerContract: number;
  rewardToRisk: number | null;
  /** Debit if every leg fills at the wrong side of its spread. Slippage, made explicit. */
  worstCaseDebit: number | null;
  slippageMultiple: number | null;
  rejected: string | null;
}

// --- Fillability gates -------------------------------------------------------
// Testing surfaced two proposals that satisfied every economic rule and were still
// untradeable: a 1-wide call fly at a $0.04 mid sized to 12 contracts, and a $40 account
// that produced a "viable" trade on a $2 budget. Both were arithmetically fine and
// commercially nonsense. A mid is only meaningful if there is a two-sided market behind
// it, and a structure narrower than the noise is not a pin trade.

/** Every leg needs a real bid. A zero bid means nobody is buying it at any price. */
export const MIN_LEG_BID = 0.01;

/**
 * Wings must span a meaningful fraction of the expected move. A 1-wide fly against a
 * $10.42 expected move is inside the noise: the underlying passes through the whole
 * structure without the body ever pinning.
 */
export const MIN_WIDTH_AS_FRACTION_OF_SIGMA = 0.25;

/**
 * Below this the debit is dominated by tick granularity -- a penny of adverse fill is a
 * double-digit percentage of the position.
 */
export const MIN_DEBIT = 0.05;

/**
 * Worst-case fill (buy both wings at the ask, sell the body at the bid) divided by the mid
 * debit. Above this the spread is wide enough that the quoted economics are fiction.
 */
export const MAX_SLIPPAGE_MULTIPLE = 2.5;

/**
 * A defined-risk budget can technically buy a great many cheap contracts. Commission and
 * fill risk scale with leg count, so the lot size is capped independently of the dollars.
 */
export const MAX_CONTRACTS = 10;

// A thin target expiration still fills, but the wing quotes are wide and a bigger lot
// multiplies that slippage on both entry and exit. The user's rule for a thin week is to
// keep the cadence and hold the lot small rather than take the full budget's worth.
export const THIN_EXPIRATION_MAX_CONTRACTS = 2;

export interface FlyProposal {
  viable: boolean;
  reason: string | null;
  asOf: string;
  symbol: string;
  spot: number;
  optionType: "call" | "put" | null;
  expiration: string | null;
  lowerStrike: number | null;
  middleStrike: number | null;
  upperStrike: number | null;
  contracts: number | null;
  entryDebit: number | null;
  maxLoss: number | null;
  maxProfit: number | null;
  rewardToRisk: number | null;
  breakevenLower: number | null;
  breakevenUpper: number | null;
  riskBudget: number;
  thresholds: ThresholdReachability | null;
  bodyRationale: string | null;
  wingRationale: string | null;
  sizingRationale: string | null;
  consideredWings: WingCandidate[];
  rejectedBodies: Array<{ strike: number; reason: string }>;
}

/**
 * Which side to build, and where the playbook wants the body.
 *
 * The wall in this book is an OVERHEAD level (it is cross-referenced against a published
 * breakout level), so the branch names do not mean what they look like they mean:
 *
 *   rejects - "fades below the wall", the bear base case. Put fly below spot.
 *   grinds  - "holds at the wall". NOT a stand-down. The playbook re-centers, shifting fly
 *             bodies about 2% below the open so the tent keeps a defined distance from
 *             spot. Still the put side, but placed by offset rather than by gamma.
 *   breaks  - "sustained through the wall". This is the BULL branch, not a breakdown:
 *             price pushing up through the breakout level. Call fly above spot.
 *
 * An earlier draft of this function mapped breaks to a put fly and treated grinds as a
 * stand-down. Both were wrong, and both would have built a structure pointing the opposite
 * way from the branch the operator keyed. The mapping is spelled out here rather than
 * inferred anywhere else.
 */
export type BodyPreference = "gammaPeak" | "offsetBelowOpen";

export interface BranchPolicy {
  /** Breaks only: the body must sit strictly above the keyed wall, not merely above spot. */
  requiresBodyAboveWall: boolean;
  optionType: "call" | "put" | null;
  bodyPreference: BodyPreference;
  /** Fractional offset from the reference open, used only by the grinds branch. */
  offsetFromOpen: number | null;
  standDown: boolean;
  note: string;
}

/** The grinds branch shifts fly bodies about 2% below the open. */
export const GRINDS_BODY_OFFSET = -0.02;

export function branchPolicy(branch: string): BranchPolicy {
  const b = (branch || "").toLowerCase();
  if (b === "rejects") {
    return {
      requiresBodyAboveWall: false,
      optionType: "put",
      bodyPreference: "gammaPeak",
      offsetFromOpen: null,
      standDown: false,
      note: "Wall rejects (fades below the wall) is the bear base case: put fly with the body below spot.",
    };
  }
  if (b === "grinds") {
    return {
      requiresBodyAboveWall: false,
      optionType: "put",
      bodyPreference: "offsetBelowOpen",
      offsetFromOpen: GRINDS_BODY_OFFSET,
      standDown: false,
      note:
        "Wall grinds (holds at the wall) re-centers rather than standing down: bodies shift " +
        "about 2% below the open so the tent keeps a defined distance from spot.",
    };
  }
  if (b === "breaks") {
    return {
      requiresBodyAboveWall: true,
      optionType: "call",
      bodyPreference: "gammaPeak",
      offsetFromOpen: null,
      standDown: false,
      note:
        "Wall breaks (sustained through the wall) is the bull branch: price pushing up through " +
        "the level, so a call fly with the body above spot. The playbook also cuts the bear " +
        "ladder to fewer lots and pulls the Thursday reserve fly forward as the primary trade.",
    };
  }
  return {
    requiresBodyAboveWall: false,
    optionType: null,
    bodyPreference: "gammaPeak",
    offsetFromOpen: null,
    standDown: true,
    note: `Branch "${branch || "unset"}" is not one of rejects/grinds/breaks, so no side is defined. Stand down.`,
  };
}

function emptyProposal(
  reason: string,
  asOf: string,
  symbol: string,
  spot: number,
  riskBudget: number
): FlyProposal {
  return {
    viable: false,
    reason,
    asOf,
    symbol,
    spot,
    optionType: null,
    expiration: null,
    lowerStrike: null,
    middleStrike: null,
    upperStrike: null,
    contracts: null,
    entryDebit: null,
    maxLoss: null,
    maxProfit: null,
    rewardToRisk: null,
    breakevenLower: null,
    breakevenUpper: null,
    riskBudget,
    thresholds: null,
    bodyRationale: null,
    wingRationale: null,
    sizingRationale: null,
    consideredWings: [],
    rejectedBodies: [],
  };
}

export function buildProposal(
  chain: ChainData | null,
  analysis: ChainAnalysis,
  branch: BranchPolicy,
  settings: ProposalSettings,
  policy: ExitPolicy,
  referenceOpen?: number | null,
  // The keyed wall price. Required to place a breaks body correctly: without it the engine
  // can only ask "is this above spot", which on a break thesis is not the same question.
  wallPrice?: number | null
): FlyProposal {
  const asOf = analysis.asOf ?? new Date().toISOString();
  const symbol = analysis.symbol ?? "";
  const spot = analysis.spot ?? 0;
  const riskBudget = round2((settings.accountBalance * settings.riskPerTradePercent) / 100);
  const optionType = branch.optionType;

  if (branch.standDown || !optionType) {
    return emptyProposal(branch.note, asOf, symbol, spot, riskBudget);
  }
  if (!analysis.available) {
    return emptyProposal(
      `Chain analysis unavailable: ${analysis.reason ?? "unknown"}. No structure can be priced.`,
      asOf,
      symbol,
      spot,
      riskBudget
    );
  }
  if (!chain || !analysis.targetExpiration) {
    return emptyProposal(
      "No target expiration or chain data available.",
      asOf,
      symbol,
      spot,
      riskBudget
    );
  }
  if (riskBudget <= 0) {
    return emptyProposal(
      `Risk budget is $${riskBudget}. Nothing can be sized.`,
      asOf,
      symbol,
      spot,
      riskBudget
    );
  }

  const expiration = analysis.targetExpiration;
  const rejectedBodies: Array<{ strike: number; reason: string }> = [];
  const oneSigma = analysis.expectedMove?.oneSigmaDollars ?? 0;

  const legs = chain.options.filter(
    (o) => o.expiration === expiration && o.type === optionType
  );
  const byStrike = new Map<number, ChainOption>();
  for (const o of legs) byStrike.set(o.strike, o);

  const gammaRank = new Map<number, number>();
  for (const g of analysis.gammaWall?.topStrikes ?? []) {
    gammaRank.set(g.strike, g.gammaWeightedOi);
  }

  // --- Body -----------------------------------------------------------------
  let bodyStrike: number;
  let bodyRationale: string;

  if (branch.bodyPreference === "offsetBelowOpen") {
    // The grinds branch places the body by price offset, not by gamma. It re-centers to a
    // fixed distance below the open, which is a different rule from the largest-gamma lens
    // and is applied on its own terms rather than blended with it.
    const anchor = referenceOpen && referenceOpen > 0 ? referenceOpen : spot;
    const anchorLabel =
      referenceOpen && referenceOpen > 0
        ? `the open ${round2(anchor)}`
        : `spot ${round2(anchor)} (no open recorded, spot substituted)`;
    const target = anchor * (1 + (branch.offsetFromOpen ?? GRINDS_BODY_OFFSET));
    const listed = Array.from(byStrike.keys());
    if (!listed.length) {
      return {
        ...emptyProposal(
          `No ${optionType} strikes listed on ${expiration}.`,
          asOf,
          symbol,
          spot,
          riskBudget
        ),
        optionType,
        expiration,
      };
    }
    bodyStrike = listed
      .slice()
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    const movesAway = oneSigma > 0 ? round2(Math.abs(bodyStrike - spot) / oneSigma) : null;
    // The offset rule still answers to the two-expected-move disqualification. A re-center
    // that lands beyond the expected move is the same hope trade under a different name.
    if (movesAway != null && movesAway > 2) {
      rejectedBodies.push({
        strike: bodyStrike,
        reason: `${movesAway} expected moves from spot exceeds the 2-move limit`,
      });
      return {
        ...emptyProposal(
          `The grinds re-center targets ${round2(target)} (2% below ${anchorLabel}), nearest listed ` +
            `strike ${bodyStrike}, which is ${movesAway} expected moves from spot ${spot}. That is ` +
            `beyond the two-move limit, so the re-center does not produce a tradeable body.`,
          asOf,
          symbol,
          spot,
          riskBudget
        ),
        optionType,
        expiration,
        rejectedBodies,
      };
    }
    bodyRationale =
      `Body at ${bodyStrike}: the grinds branch re-centers to 2% below ${anchorLabel}, ` +
      `target ${round2(target)}, nearest listed strike ${bodyStrike}` +
      (movesAway == null ? "" : `, ${movesAway} expected moves from spot ${spot}`) +
      `. Placed by the playbook's offset rule, not by gamma` +
      (gammaRank.has(bodyStrike)
        ? ` (it also carries gamma-weighted OI ${gammaRank.get(bodyStrike)})`
        : ` (it is not among the top gamma strikes)`) +
      `.`;
  } else {
    // Only candidates the chain analysis already scored as inside the two-expected-move
    // limit are eligible; the disqualification is enforced here as well as reported, so a
    // disqualified level cannot reach a position by any path through this function.
    const eligible = (analysis.bodyCandidates ?? []).filter((c) => {
      if (!c.qualifiesAsPinBody) {
        rejectedBodies.push({
          strike: c.strike,
          reason: `${c.expectedMovesFromSpot} expected moves from spot exceeds the 2-move limit`,
        });
        return false;
      }
      return true;
    });

    // Direction has to agree with the structure: a put fly pins from below, so its body
    // belongs at or under spot. A qualifying strike on the wrong side of spot is a valid
    // wall but the wrong instrument for it.
    const sideFiltered = eligible.filter((c) => {
      const onRightSide = optionType === "put" ? c.strike <= spot : c.strike >= spot;
      if (!onRightSide) {
        rejectedBodies.push({
          strike: c.strike,
          reason: `on the wrong side of spot ${spot} for a ${optionType} fly`,
        });
      }
      return onRightSide;
    });

    // On breaks the thesis is that price pushes THROUGH the wall and keeps going, so the
    // tent has to sit above the wall. Filtering on spot alone is not enough: a body at or
    // just under the wall pays maximally when price pins at the level, which is the stall
    // case the breaks branch exists to rule out. Only breaks needs this -- rejects and
    // grinds place bodies below spot, away from an overhead wall, so the wall is not a
    // binding constraint there.
    const wallFiltered =
      branch.requiresBodyAboveWall && wallPrice != null && wallPrice > 0
        ? sideFiltered.filter((c) => {
            if (c.strike <= wallPrice) {
              rejectedBodies.push({
                strike: c.strike,
                reason:
                  `at or below the keyed wall ${wallPrice}; a breaks body must sit above the ` +
                  `wall, otherwise the structure pays most when price stalls at the level ` +
                  `instead of breaking through it`,
              });
              return false;
            }
            return true;
          })
        : sideFiltered;

    if (branch.requiresBodyAboveWall && (wallPrice == null || wallPrice <= 0)) {
      return {
        ...emptyProposal(
          `The breaks branch needs the keyed wall price to place the body above the wall, and ` +
            `no usable wall price was supplied. Standing down rather than centring the tent on ` +
            `an unknown level.`,
          asOf,
          symbol,
          spot,
          riskBudget
        ),
        optionType,
        expiration,
        rejectedBodies,
      };
    }

    if (!wallFiltered.length && sideFiltered.length) {
      return {
        ...emptyProposal(
          `No qualifying body above the keyed wall ${wallPrice} for a ${optionType} fly. ` +
            `${sideFiltered.length} candidate${sideFiltered.length === 1 ? "" : "s"} sat above spot ` +
            `${spot} but at or below the wall, which is the stall case rather than a break.`,
          asOf,
          symbol,
          spot,
          riskBudget
        ),
        optionType,
        expiration,
        rejectedBodies,
      };
    }

    if (!sideFiltered.length) {
      return {
        ...emptyProposal(
          `No qualifying body for a ${optionType} fly. Every candidate was either beyond the ` +
            `two-expected-move limit or on the wrong side of spot ${spot}.`,
          asOf,
          symbol,
          spot,
          riskBudget
        ),
        optionType,
        expiration,
        rejectedBodies,
      };
    }

    // Among qualifying, correctly-sided candidates, take the greatest gamma-weighted open
    // interest -- the largest-gamma lens, which is the pinning force the structure is
    // betting on. Ranking by raw OI instead would favour a far strike with heavy aggregate
    // interest and no gamma.
    const body = wallFiltered
      .slice()
      .sort((a, b) => (gammaRank.get(b.strike) ?? 0) - (gammaRank.get(a.strike) ?? 0))[0];
    bodyStrike = body.strike;
    const bodyGamma = gammaRank.get(bodyStrike) ?? null;
    bodyRationale =
      `Body at ${bodyStrike}: highest gamma-weighted open interest` +
      (bodyGamma == null ? "" : ` (${bodyGamma})`) +
      ` among strikes inside the two-expected-move limit and on the correct side of spot ` +
      `${spot} for a ${optionType} fly` +
      (branch.requiresBodyAboveWall && wallPrice != null
        ? `, and above the keyed wall ${wallPrice}`
        : "") +
      `. ${body.expectedMovesFromSpot} expected moves away. ${branch.note}`;
  }

  // --- Wings ----------------------------------------------------------------
  const bodyLeg = byStrike.get(bodyStrike);
  if (!bodyLeg) {
    return {
      ...emptyProposal(
        `Body strike ${bodyStrike} has no ${optionType} quote on ${expiration}.`,
        asOf,
        symbol,
        spot,
        riskBudget
      ),
      optionType,
      expiration,
      rejectedBodies,
    };
  }

  const strikes = Array.from(byStrike.keys()).sort((a, b) => a - b);
  const widths = candidateWidths(strikes, bodyStrike);
  const considered: WingCandidate[] = [];
  const minWidth = oneSigma > 0 ? oneSigma * MIN_WIDTH_AS_FRACTION_OF_SIGMA : 0;

  for (const width of widths) {
    const lower = byStrike.get(bodyStrike - width);
    const upper = byStrike.get(bodyStrike + width);
    const base: WingCandidate = {
      width,
      lowerStrike: bodyStrike - width,
      upperStrike: bodyStrike + width,
      debit: 0,
      debitToWidth: 0,
      maxLossPerContract: 0,
      rewardToRisk: null,
      worstCaseDebit: null,
      slippageMultiple: null,
      rejected: null,
    };
    if (!lower || !upper) {
      considered.push({ ...base, rejected: "one or both wing strikes are not listed" });
      continue;
    }
    // Long butterfly: buy one of each wing, sell two bodies. Priced off mids; a
    // zero or negative mid means the feed has no usable two-sided market.
    if (!(lower.mid > 0) || !(upper.mid > 0) || !(bodyLeg.mid > 0)) {
      considered.push({ ...base, rejected: "no usable mid on one or more legs" });
      continue;
    }
    const debit = round2(lower.mid + upper.mid - 2 * bodyLeg.mid);
    const ratio = round4(debit / width);
    const worstCase = round2(lower.ask + upper.ask - 2 * bodyLeg.bid);
    const cand: WingCandidate = {
      ...base,
      debit,
      debitToWidth: ratio,
      maxLossPerContract: round2(debit * getMultiplier(symbol)),
      rewardToRisk: debit > 0 ? round2((width - debit) / debit) : null,
      worstCaseDebit: worstCase,
      slippageMultiple: debit > 0 ? round2(worstCase / debit) : null,
    };
    if (debit <= 0) {
      considered.push({ ...cand, rejected: "non-positive debit; quotes are crossed or stale" });
      continue;
    }
    if (width < minWidth) {
      considered.push({
        ...cand,
        rejected:
          `${width}-wide is narrower than the ${round2(minWidth)} floor ` +
          `(${MIN_WIDTH_AS_FRACTION_OF_SIGMA} of the $${round2(oneSigma)} expected move); ` +
          `the structure sits inside the noise`,
      });
      continue;
    }
    if (debit < MIN_DEBIT) {
      considered.push({
        ...cand,
        rejected: `$${debit} debit is below the $${MIN_DEBIT} floor; tick noise dominates it`,
      });
      continue;
    }
    if (!(lower.bid >= MIN_LEG_BID) || !(upper.bid >= MIN_LEG_BID) || !(bodyLeg.bid >= MIN_LEG_BID)) {
      considered.push({ ...cand, rejected: "one or more legs has no bid; there is no two-sided market" });
      continue;
    }
    if (cand.slippageMultiple != null && cand.slippageMultiple > MAX_SLIPPAGE_MULTIPLE) {
      considered.push({
        ...cand,
        rejected:
          `worst-case fill $${worstCase} is ${cand.slippageMultiple}x the $${debit} mid, ` +
          `over the ${MAX_SLIPPAGE_MULTIPLE}x ceiling; the spread makes the quoted economics fiction`,
      });
      continue;
    }
    if (ratio > settings.maxDebitToWidth) {
      considered.push({
        ...cand,
        rejected: `debit is ${ratio} of width, richer than the ${settings.maxDebitToWidth} ceiling`,
      });
      continue;
    }
    if (debit * getMultiplier(symbol) > riskBudget) {
      considered.push({
        ...cand,
        rejected: `a single contract risks $${round2(debit * getMultiplier(symbol))}, over the $${riskBudget} budget`,
      });
      continue;
    }
    considered.push(cand);
  }

  const usable = considered.filter((c) => !c.rejected);
  if (!usable.length) {
    return {
      ...emptyProposal(
        `Body ${bodyStrike} is viable but no wing width could be priced within the risk budget ` +
          `and the ${settings.maxDebitToWidth} debit-to-width ceiling.`,
        asOf,
        symbol,
        spot,
        riskBudget
      ),
      optionType,
      expiration,
      rejectedBodies,
      consideredWings: considered,
    };
  }

  // Pick the width whose debit-to-width sits closest to target. Not the cheapest
  // available: the cheapest is cheap because a pin is least likely, and chasing it walks
  // the body further from any realistic move.
  const chosen = usable
    .slice()
    .sort(
      (a, b) =>
        Math.abs(a.debitToWidth - settings.targetDebitToWidth) -
        Math.abs(b.debitToWidth - settings.targetDebitToWidth)
    )[0];

  // --- Size -----------------------------------------------------------------
  const multiplier = getMultiplier(symbol);
  const perContractRisk = chosen.debit * multiplier;
  const isThinExpiration = analysis.liquidity?.isThin === true;
  const lotCeiling = isThinExpiration ? THIN_EXPIRATION_MAX_CONTRACTS : MAX_CONTRACTS;
  const budgetContracts = Math.floor(riskBudget / perContractRisk);
  const contracts = Math.min(budgetContracts, lotCeiling);
  if (contracts < 1) {
    return {
      ...emptyProposal(
        `One contract risks $${round2(perContractRisk)} against a $${riskBudget} budget.`,
        asOf,
        symbol,
        spot,
        riskBudget
      ),
      optionType,
      expiration,
      rejectedBodies,
      consideredWings: considered,
    };
  }

  const econ = deriveFlyEconomics(
    chosen.lowerStrike,
    bodyStrike,
    chosen.upperStrike,
    contracts,
    chosen.debit,
    multiplier
  );

  const thresholds = assessThresholdReachability(
    policy,
    chosen.debit,
    econ.maxProfit,
    econ.maxLoss,
    contracts,
    multiplier,
    null
  );

  return {
    viable: true,
    reason: null,
    asOf,
    symbol,
    spot,
    optionType,
    expiration,
    lowerStrike: chosen.lowerStrike,
    middleStrike: bodyStrike,
    upperStrike: chosen.upperStrike,
    contracts,
    entryDebit: chosen.debit,
    maxLoss: round2(econ.maxLoss),
    maxProfit: round2(econ.maxProfit),
    rewardToRisk: econ.rewardToRisk == null ? null : round2(econ.rewardToRisk),
    breakevenLower: round2(econ.breakevenLower),
    breakevenUpper: round2(econ.breakevenUpper),
    riskBudget,
    thresholds,
    bodyRationale,
    wingRationale:
      `${chosen.width}-wide wings ${chosen.lowerStrike}/${bodyStrike}/${chosen.upperStrike} ` +
      `at a $${chosen.debit} debit, ${chosen.debitToWidth} of width against a ` +
      `${settings.targetDebitToWidth} target. Theoretical reward:risk ${chosen.rewardToRisk}:1. ` +
      `Worst-case fill $${chosen.worstCaseDebit} (${chosen.slippageMultiple}x the mid). ` +
      `${considered.length - usable.length} of ${considered.length} widths were rejected.`,
    sizingRationale:
      `${contracts} contract${contracts === 1 ? "" : "s"} at $${round2(perContractRisk)} risk each ` +
      `= $${round2(econ.maxLoss)} of the $${riskBudget} budget ` +
      `(${settings.riskPerTradePercent}% of $${settings.accountBalance}). ` +
      `Capital deployed equals max loss.` +
      (budgetContracts > lotCeiling
        ? ` Budget allowed ${budgetContracts} contracts but the lot is capped at ${lotCeiling}` +
          (isThinExpiration
            ? `, because the target expiration is thin (${analysis.liquidity?.putOpenInterest} put OI, ` +
              `${Math.round((analysis.liquidity?.targetShareOfDeepest ?? 0) * 100)}% of ` +
              `${analysis.liquidity?.deepestNearbyExpiration}) and a bigger lot multiplies the wide-quote ` +
              `slippage on both entry and exit`
            : ``) +
          `.`
        : ""),
    consideredWings: considered,
    rejectedBodies,
  };
}

/**
 * Symmetric wing widths available around the body, derived from the strikes the chain
 * actually lists rather than assumed to be 1s or 5s. Only widths with a listed strike on
 * both sides are offered, and the search is capped so a sparse chain cannot generate
 * absurdly wide structures.
 */
function candidateWidths(strikes: number[], body: number): number[] {
  const set = new Set(strikes);
  const widths: number[] = [];
  const above = strikes.filter((s) => s > body);
  const below = strikes.filter((s) => s < body);
  const reach = Math.min(
    above.length ? above[above.length - 1] - body : 0,
    below.length ? body - below[0] : 0
  );
  for (const s of above) {
    const w = round2(s - body);
    if (w <= 0 || w > reach) continue;
    if (set.has(body - w)) widths.push(w);
  }
  return widths.sort((a, b) => a - b);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
