// Debit butterfly / broken-wing butterfly economics.
// Structure: +1 lower, -2 middle, +1 upper (all calls or all puts), scaled by `contracts`.
// Mirrors the project's defined-risk accounting: max loss = net debit paid (or BWB max loss),
// max profit = theoretical ceiling at a perfect body pin at expiry.

export type ChainLeg = {
  strike: number;
  type: "call" | "put";
  bid: number;
  ask: number;
  mid: number;
};

export type FlyLegs = {
  optionType: "call" | "put";
  lowerStrike: number;
  middleStrike: number;
  upperStrike: number;
  contracts: number;
};

export type FlyPricing = {
  lowerLeg?: ChainLeg;
  middleLeg?: ChainLeg;
  upperLeg?: ChainLeg;
  midDebit: number | null; // per-share debit using mid prices
  worstDebit: number | null; // per-share debit using ask (buys) / bid (sells) — conservative fill estimate
  maxLossMid: number | null; // dollars, using mid debit
  maxLossWorst: number | null; // dollars, using worst-case debit
  maxProfit: number | null; // dollars, theoretical ceiling (mid-debit basis)
  breakevenLower: number | null;
  breakevenUpper: number | null;
  rewardToRiskMid: number | null;
  isBrokenWing: boolean;
  lowerWingWidth: number;
  upperWingWidth: number;
};

function findLeg(options: ChainLeg[], strike: number, type: "call" | "put"): ChainLeg | undefined {
  return options.find((o) => Math.abs(o.strike - strike) < 0.001 && o.type === type);
}

export function computeFlyPricing(legs: FlyLegs, chainOptions: ChainLeg[]): FlyPricing {
  const { optionType, lowerStrike, middleStrike, upperStrike, contracts } = legs;
  const lowerLeg = findLeg(chainOptions, lowerStrike, optionType);
  const middleLeg = findLeg(chainOptions, middleStrike, optionType);
  const upperLeg = findLeg(chainOptions, upperStrike, optionType);

  const lowerWingWidth = middleStrike - lowerStrike;
  const upperWingWidth = upperStrike - middleStrike;
  const isBrokenWing = Math.abs(lowerWingWidth - upperWingWidth) > 0.001;

  let midDebit: number | null = null;
  let worstDebit: number | null = null;

  if (lowerLeg && middleLeg && upperLeg) {
    // Buy lower, sell 2x middle, buy upper
    midDebit = lowerLeg.mid - 2 * middleLeg.mid + upperLeg.mid;
    // Worst-case fills: pay ask on buys, receive bid on the sells
    worstDebit = lowerLeg.ask - 2 * middleLeg.bid + upperLeg.ask;
  }

  const maxLossMid = midDebit !== null ? Math.max(midDebit, 0) * 100 * contracts : null;
  const maxLossWorst = worstDebit !== null ? Math.max(worstDebit, 0) * 100 * contracts : null;

  // Max profit at a perfect pin on the body: (narrower wing width - debit) * 100 * contracts.
  const narrowerWing = Math.min(lowerWingWidth, upperWingWidth);
  const maxProfit =
    midDebit !== null ? Math.max((narrowerWing - midDebit) * 100 * contracts, 0) : null;

  const breakevenLower = midDebit !== null ? lowerStrike + midDebit : null;
  const breakevenUpper = midDebit !== null ? upperStrike - midDebit : null;

  const rewardToRiskMid =
    maxProfit !== null && maxLossMid !== null && maxLossMid > 0 ? maxProfit / maxLossMid : null;

  return {
    lowerLeg,
    middleLeg,
    upperLeg,
    midDebit,
    worstDebit,
    maxLossMid,
    maxLossWorst,
    maxProfit,
    breakevenLower,
    breakevenUpper,
    rewardToRiskMid,
    isBrokenWing,
    lowerWingWidth,
    upperWingWidth,
  };
}

// R-multiple: realized P&L divided by basis (entry debit paid, i.e. max loss).
export function rMultiple(realizedPnl: number, basis: number): number | null {
  if (!basis || basis <= 0) return null;
  return realizedPnl / basis;
}

export function computeJournalStats(
  closedFlies: { entryDebit: number; exitDebit: number | null; contracts: number; maxLoss: number }[]
) {
  const withPnl = closedFlies.map((f) => {
    const pnl = ((f.exitDebit ?? 0) - f.entryDebit) * 100 * f.contracts;
    return { pnl, basis: f.maxLoss };
  });

  const wins = withPnl.filter((f) => f.pnl > 0);
  const losses = withPnl.filter((f) => f.pnl <= 0);
  const grossProfit = wins.reduce((s, f) => s + f.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, f) => s + f.pnl, 0));
  const totalPnl = withPnl.reduce((s, f) => s + f.pnl, 0);
  const winRate = withPnl.length > 0 ? wins.length / withPnl.length : null;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null;
  const rMultiples = withPnl.map((f) => rMultiple(f.pnl, f.basis)).filter((r): r is number => r !== null);
  const avgR = rMultiples.length > 0 ? rMultiples.reduce((s, r) => s + r, 0) / rMultiples.length : null;

  return { totalPnl, winRate, profitFactor, avgR, tradeCount: withPnl.length };
}
