// Debit butterfly / broken-wing butterfly economics.
// Structure: +1 lower, -2 middle, +1 upper (all calls or all puts), scaled by `contracts`.
// Mirrors the project's defined-risk accounting: max loss = net debit paid (or BWB max loss),
// max profit = theoretical ceiling at a perfect body pin at expiry.
//
// `multiplier` is the dollar value per 1.00 move in the underlying, per contract:
// 100 for standard equity/ETF options (QQQ, SPY), 5 for MES futures options (CME micro
// E-mini S&P 500 — $5 x index, per CME contract specs), 100 default otherwise.

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
  midDebit: number | null; // per-share/per-point debit using mid prices
  worstDebit: number | null; // per-share/per-point debit using ask (buys) / bid (sells) — conservative fill estimate
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

// Per-contract dollar value of a 1.00 move in the underlying/index.
// QQQ/SPY equity options: $100/contract (standard). MES futures options: $5/contract
// (CME Micro E-mini S&P 500 multiplier — see cmegroup.com contract specs). Defaults to 100.
export function getMultiplier(symbol: string): number {
  return symbol.toUpperCase() === "MES" ? 5 : 100;
}

function findLeg(options: ChainLeg[], strike: number, type: "call" | "put"): ChainLeg | undefined {
  return options.find((o) => Math.abs(o.strike - strike) < 0.001 && o.type === type);
}

export function computeFlyPricing(
  legs: FlyLegs,
  chainOptions: ChainLeg[],
  multiplier = 100
): FlyPricing {
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

  const maxLossMid = midDebit !== null ? Math.max(midDebit, 0) * multiplier * contracts : null;
  const maxLossWorst = worstDebit !== null ? Math.max(worstDebit, 0) * multiplier * contracts : null;

  // Max profit at a perfect pin on the body: (narrower wing width - debit) * multiplier * contracts.
  const narrowerWing = Math.min(lowerWingWidth, upperWingWidth);
  const maxProfit =
    midDebit !== null ? Math.max((narrowerWing - midDebit) * multiplier * contracts, 0) : null;

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

export type ManualFlyEconomics = {
  maxLoss: number;
  maxProfit: number;
  breakevenLower: number;
  breakevenUpper: number;
  rewardToRisk: number | null;
  isBrokenWing: boolean;
};

// Same economics formulas as computeFlyPricing, but driven off a manually entered
// debit instead of a live chain lookup — used for symbols with no options-chain feed (e.g. MES).
export function deriveFlyEconomics(
  lowerStrike: number,
  middleStrike: number,
  upperStrike: number,
  contracts: number,
  debit: number,
  multiplier = 100
): ManualFlyEconomics {
  const lowerWingWidth = middleStrike - lowerStrike;
  const upperWingWidth = upperStrike - middleStrike;
  const isBrokenWing = Math.abs(lowerWingWidth - upperWingWidth) > 0.001;
  const narrowerWing = Math.min(lowerWingWidth, upperWingWidth);

  const maxLoss = Math.max(debit, 0) * multiplier * contracts;
  const maxProfit = Math.max((narrowerWing - debit) * multiplier * contracts, 0);
  const breakevenLower = lowerStrike + debit;
  const breakevenUpper = upperStrike - debit;
  const rewardToRisk = maxLoss > 0 ? maxProfit / maxLoss : null;

  return { maxLoss, maxProfit, breakevenLower, breakevenUpper, rewardToRisk, isBrokenWing };
}

export type PayoffPoint = { price: number; pnl: number };

// Theoretical P&L at expiration across a range of underlying prices for a debit
// butterfly (or broken-wing butterfly). Pure intrinsic-value math -- no Black-Scholes
// or time value involved, since expiration payoff only depends on where the
// underlying settles relative to the three strikes.
export function buildPayoffCurve(
  optionType: "call" | "put",
  lowerStrike: number,
  middleStrike: number,
  upperStrike: number,
  contracts: number,
  debit: number,
  multiplier = 100,
  opts?: { spot?: number | null; points?: number }
): PayoffPoint[] {
  const totalWidth = upperStrike - lowerStrike;
  const pad = Math.max(totalWidth * 0.5, 1);
  let rangeLow = lowerStrike - pad;
  let rangeHigh = upperStrike + pad;
  if (opts?.spot != null && Number.isFinite(opts.spot)) {
    rangeLow = Math.min(rangeLow, opts.spot - pad * 0.3);
    rangeHigh = Math.max(rangeHigh, opts.spot + pad * 0.3);
  }

  const intrinsicAt = (price: number) =>
    optionType === "call"
      ? Math.max(price - lowerStrike, 0) - 2 * Math.max(price - middleStrike, 0) + Math.max(price - upperStrike, 0)
      : Math.max(lowerStrike - price, 0) - 2 * Math.max(middleStrike - price, 0) + Math.max(upperStrike - price, 0);

  const pnlAt = (price: number) => Number(((intrinsicAt(price) - debit) * multiplier * contracts).toFixed(2));

  const count = opts?.points ?? 60;
  const step = (rangeHigh - rangeLow) / count;
  const prices = new Set<number>();
  for (let i = 0; i <= count; i++) prices.add(Number((rangeLow + step * i).toFixed(2)));
  // Ensure the kink points (wings + body) land exactly on the curve for a crisp peak/floor.
  [lowerStrike, middleStrike, upperStrike].forEach((s) => prices.add(Number(s.toFixed(2))));

  return Array.from(prices)
    .sort((a, b) => a - b)
    .map((price) => ({ price, pnl: pnlAt(price) }));
}

// R-multiple: realized P&L divided by basis (entry debit paid, i.e. max loss).
export function rMultiple(realizedPnl: number, basis: number): number | null {
  if (!basis || basis <= 0) return null;
  return realizedPnl / basis;
}

export function computeJournalStats(
  closedFlies: {
    symbol: string;
    entryDebit: number;
    exitDebit: number | null;
    contracts: number;
    maxLoss: number;
  }[]
) {
  const withPnl = closedFlies.map((f) => {
    const pnl = ((f.exitDebit ?? 0) - f.entryDebit) * getMultiplier(f.symbol) * f.contracts;
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
