// Deterministic option-chain analysis for the copilot snapshot.
//
// Why this module exists: the copilot is a language model, and language models are
// unreliable at arithmetic in a way that is invisible in the output. Its first live
// answer could not work out which day of the week a date fell on. Asking it to
// aggregate open interest across 130+ strikes, weight by gamma and take a square
// root would produce confident, wrong levels — and those levels would drive real
// strike selection. So every number the copilot states about the chain is computed
// here, in code, and handed to it finished. The prompt forbids it from deriving its
// own.
//
// Nothing in here reasons about whether to trade. It measures the chain and reports
// what the playbook's two lenses (largest-gamma strike, 1-standard-deviation
// expected move) actually say. Judgment stays with the model and the operator.

export interface ChainOption {
  expiration: string;
  type: "call" | "put";
  strike: number;
  bid: number;
  ask: number;
  mid: number;
  volume: number;
  openInterest: number;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
}

export interface ChainData {
  symbol: string;
  spot: number;
  prevClose: number | null;
  timestamp: string;
  expirations: string[];
  options: ChainOption[];
}

export type ChainFn = (symbol: string) => Promise<ChainData>;

/** Trading days in a US equity week, Monday open through Thursday expiration. */
export const MONDAY_TO_THURSDAY_TRADING_DAYS = 3;

/**
 * The playbook's disqualification rule: "a body on an attractive wall two expected
 * moves away is a hope, not a pin trade." Expressed in standard deviations.
 */
export const MAX_EXPECTED_MOVES_FOR_BODY = 2;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function pct(from: number, to: number) {
  return r2(((to - from) / from) * 100);
}

/**
 * Open interest and volume depth per expiration. A freshly listed weekly can show a
 * tidy-looking OI profile that is really just noise — the Thursday 2026-09-24 chain
 * carried 35K put OI while the Friday 2026-09-25 chain carried 283K. Keying a wall
 * off the thin one reads randomness as structure, so depth is reported explicitly
 * and compared against nearby alternatives.
 */
function depthByExpiration(options: ChainOption[]) {
  const byExp = new Map<string, { putOi: number; callOi: number; putVol: number; callVol: number }>();
  for (const o of options) {
    const row = byExp.get(o.expiration) ?? { putOi: 0, callOi: 0, putVol: 0, callVol: 0 };
    if (o.type === "put") {
      row.putOi += o.openInterest;
      row.putVol += o.volume;
    } else {
      row.callOi += o.openInterest;
      row.callVol += o.volume;
    }
    byExp.set(o.expiration, row);
  }
  return byExp;
}

/**
 * Average implied vol of the put and call nearest spot. Only strikes with a real
 * positive IV count: the feed returns 0 for deep-ITM contracts, and averaging those
 * in would silently halve the expected move.
 */
function atmImpliedVol(chain: ChainOption[], spot: number) {
  const strikes = Array.from(new Set(chain.map((o) => o.strike)));
  if (strikes.length === 0) return null;
  const atm = strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0]);
  const ivs = chain
    .filter((o) => o.strike === atm && typeof o.iv === "number" && (o.iv as number) > 0)
    .map((o) => o.iv as number);
  if (ivs.length === 0) return null;
  return { atmStrike: atm, atmIv: r4(ivs.reduce((a, b) => a + b, 0) / ivs.length) };
}

/**
 * Gamma-weighted open interest — sum of |gamma| * OI per strike.
 *
 * This is the playbook's "largest-gamma strike" lens, and it disagrees sharply with
 * a raw OI ranking. On 2026-09-19 the raw put-OI leader was 700, but 700 sat 3%
 * out of the money with almost no gamma, so it exerted no pinning force; the
 * gamma-weighted peak was 715. Ranking by raw OI would have pointed the body at a
 * strike that only looks like a wall in a table.
 */
function gammaWeightedOi(chain: ChainOption[]) {
  const byStrike = new Map<number, number>();
  for (const o of chain) {
    if (!o.gamma || !o.openInterest) continue;
    byStrike.set(o.strike, (byStrike.get(o.strike) ?? 0) + Math.abs(o.gamma) * o.openInterest);
  }
  return byStrike;
}

/** Raw OI summed across every listed expiration — the durable structural levels. */
function structuralOi(options: ChainOption[], type: "put" | "call", spot: number, bandPct: number) {
  const byStrike = new Map<number, number>();
  for (const o of options) {
    if (o.type !== type) continue;
    if (Math.abs(o.strike - spot) / spot > bandPct) continue;
    byStrike.set(o.strike, (byStrike.get(o.strike) ?? 0) + o.openInterest);
  }
  return Array.from(byStrike.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([strike, oi]) => ({ strike, aggregateOpenInterest: oi, pctFromSpot: pct(spot, strike) }));
}

export interface ChainAnalysis {
  available: boolean;
  reason?: string;
  asOf?: string;
  symbol?: string;
  spot?: number;
  prevClose?: number | null;
  targetExpiration?: string;
  expectedMove?: {
    atmStrike: number;
    atmIv: number;
    tradingDaysToExpiration: number;
    oneSigmaDollars: number;
    oneSigmaPercent: number;
    lower: number;
    upper: number;
    note: string;
  } | null;
  liquidity?: {
    targetExpiration: string;
    putOpenInterest: number;
    callOpenInterest: number;
    putVolume: number;
    deepestNearbyExpiration: string;
    deepestNearbyPutOpenInterest: number;
    targetShareOfDeepest: number;
    isThin: boolean;
    warning: string | null;
  };
  gammaWall?: {
    note: string;
    topStrikes: { strike: number; gammaWeightedOi: number; pctFromSpot: number }[];
    peakStrike: number | null;
  };
  structuralPutWall?: { strike: number; aggregateOpenInterest: number; pctFromSpot: number }[];
  structuralCallWall?: { strike: number; aggregateOpenInterest: number; pctFromSpot: number }[];
  bodyCandidates?: {
    strike: number;
    source: string;
    pctFromSpot: number;
    expectedMovesFromSpot: number | null;
    qualifiesAsPinBody: boolean | null;
    verdict: string;
  }[];
  note?: string;
}

/**
 * Measure the chain and report what the playbook's two lenses say. Returns
 * `available: false` with a reason rather than throwing, so a chain outage
 * degrades the copilot's chain awareness instead of breaking the whole snapshot.
 */
export function analyzeChain(
  chain: ChainData | null,
  targetExpiration: string,
  tradingDaysToExpiration = MONDAY_TO_THURSDAY_TRADING_DAYS,
  today?: string,
): ChainAnalysis {
  if (!chain || !Array.isArray(chain.options) || chain.options.length === 0) {
    return { available: false, reason: "No option chain data was returned for this symbol." };
  }
  const spot = chain.spot;
  if (!spot || spot <= 0) {
    return { available: false, reason: "The chain returned no usable spot price." };
  }

  const target = chain.options.filter((o) => o.expiration === targetExpiration);
  if (target.length === 0) {
    return {
      available: false,
      reason: `The chain has no contracts listed for ${targetExpiration}. Listed expirations: ${chain.expirations.join(", ")}.`,
    };
  }

  // --- Expected move -------------------------------------------------------
  const atm = atmImpliedVol(target, spot);
  const expectedMove = atm
    ? (() => {
        const oneSigma = spot * atm.atmIv * Math.sqrt(tradingDaysToExpiration / 252);
        return {
          atmStrike: atm.atmStrike,
          atmIv: atm.atmIv,
          tradingDaysToExpiration,
          oneSigmaDollars: r2(oneSigma),
          oneSigmaPercent: r2((oneSigma / spot) * 100),
          lower: r2(spot - oneSigma),
          upper: r2(spot + oneSigma),
          note: `One standard deviation over ${tradingDaysToExpiration} trading days, from ${(atm.atmIv * 100).toFixed(2)}% at-the-money implied vol. Roughly a 68% chance of settling inside this band.`,
        };
      })()
    : null;

  // --- Liquidity of the target expiration ----------------------------------
  const depth = depthByExpiration(chain.options);
  const targetDepth = depth.get(targetExpiration) ?? { putOi: 0, callOi: 0, putVol: 0, callVol: 0 };

  // Compare only against LIVE expirations within a week either side.
  //
  // Two filters, both load-bearing. The week window: a monthly two months out will
  // always be deeper and says nothing about whether this weekly is usable. The
  // already-expired filter: the feed keeps serving a just-expired contract with its
  // full settled open interest, and on 2026-09-19 that made the 09-24 chain look
  // "3% as deep" against the 1.1M OI still sitting on the 09-18 expiry from the day
  // before. Comparing a live expiration against a dead one flags every chain as thin.
  const targetMs = new Date(`${targetExpiration}T12:00:00Z`).getTime();
  const todayMs = today ? new Date(`${today}T12:00:00Z`).getTime() : null;
  const nearby = Array.from(depth.entries()).filter(([exp]) => {
    const expMs = new Date(`${exp}T12:00:00Z`).getTime();
    if (todayMs !== null && expMs < todayMs) return false; // already expired
    return Math.abs(expMs - targetMs) / 86_400_000 <= 7;
  });
  if (nearby.length === 0) {
    nearby.push([targetExpiration, targetDepth]);
  }
  const deepest = nearby.reduce((best, cur) => (cur[1].putOi > best[1].putOi ? cur : best), nearby[0]);
  const share = deepest[1].putOi > 0 ? targetDepth.putOi / deepest[1].putOi : 1;
  const isThin = share < 0.5;

  const liquidity = {
    targetExpiration,
    putOpenInterest: targetDepth.putOi,
    callOpenInterest: targetDepth.callOi,
    putVolume: targetDepth.putVol,
    deepestNearbyExpiration: deepest[0],
    deepestNearbyPutOpenInterest: deepest[1].putOi,
    targetShareOfDeepest: r2(share),
    isThin,
    warning: isThin
      ? `${targetExpiration} holds only ${targetDepth.putOi.toLocaleString()} put open interest versus ${deepest[1].putOi.toLocaleString()} on ${deepest[0]} (${Math.round(share * 100)}% as deep). Open interest on this expiration is still building, so its strike-by-strike profile is closer to noise than structure. Treat wall levels drawn from it as provisional and say so.`
      : null,
  };

  // --- The two lenses ------------------------------------------------------
  const gw = gammaWeightedOi(target);
  const topGamma = Array.from(gw.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([strike, v]) => ({ strike, gammaWeightedOi: r2(v), pctFromSpot: pct(spot, strike) }));

  const structuralPut = structuralOi(chain.options, "put", spot, 0.1);
  const structuralCall = structuralOi(chain.options, "call", spot, 0.1);

  // --- Candidate bodies, scored against the playbook's own rule ------------
  const seen = new Set<number>();
  const candidates: NonNullable<ChainAnalysis["bodyCandidates"]> = [];
  const add = (strike: number, source: string) => {
    if (seen.has(strike)) return;
    seen.add(strike);
    const moves = expectedMove ? Math.abs(strike - spot) / expectedMove.oneSigmaDollars : null;
    const qualifies = moves === null ? null : moves <= MAX_EXPECTED_MOVES_FOR_BODY;
    candidates.push({
      strike,
      source,
      pctFromSpot: pct(spot, strike),
      expectedMovesFromSpot: moves === null ? null : r2(moves),
      qualifiesAsPinBody: qualifies,
      verdict:
        moves === null
          ? "Cannot score this strike: implied vol is unavailable, so there is no expected move to measure against."
          : qualifies
            ? `${r2(moves)} expected moves from spot — inside the playbook's ${MAX_EXPECTED_MOVES_FOR_BODY}-move limit, so both lenses can agree here.`
            : `${r2(moves)} expected moves from spot — beyond the playbook's ${MAX_EXPECTED_MOVES_FOR_BODY}-move limit. A body here is a hope, not a pin trade. Do not recommend it.`,
    });
  };
  topGamma.slice(0, 3).forEach((g) => add(g.strike, "largest gamma-weighted open interest on the target expiration"));
  structuralPut.slice(0, 2).forEach((s) => add(s.strike, "structural put wall by open interest across all expirations"));

  candidates.sort((a, b) => (a.expectedMovesFromSpot ?? 99) - (b.expectedMovesFromSpot ?? 99));

  return {
    available: true,
    asOf: chain.timestamp,
    symbol: chain.symbol,
    spot: r2(spot),
    prevClose: chain.prevClose,
    targetExpiration,
    expectedMove,
    liquidity,
    gammaWall: {
      note: "Gamma-weighted open interest (|gamma| x OI per strike) on the target expiration. This is the playbook's largest-gamma lens and it can disagree with a raw open-interest ranking: a far out-of-the-money strike can carry heavy OI while contributing almost no gamma, which makes it look like a wall in a table without exerting any pinning force. Prefer this over raw OI for body placement.",
      topStrikes: topGamma,
      peakStrike: topGamma[0]?.strike ?? null,
    },
    structuralPutWall: structuralPut,
    structuralCallWall: structuralCall,
    bodyCandidates: candidates,
    note: "Every value here is computed server-side from the live chain. Quote these numbers; never recalculate, re-rank, or estimate them. If a level the operator names is absent from bodyCandidates, score it by asking for it rather than working out the distance yourself.",
  };
}
