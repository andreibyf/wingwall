import { z } from "zod";

// Paraphrased from the operator's two mentor checklists, supplied 2026-09-21.
// These are operator attestations, not inferred market measurements.
export const CHECKLIST_VERSION = "mentor-2026-09-21-v1";
export const REVIEW_MINUTES = 30; // Wingwall safety policy, not a mentor rule.
export type Strategy = "butterfly" | "debit_spread";
export const COMMON = [
  {id:"gamma",label:"Gamma regime",go:"Regime identified; use the strategy-specific gamma rule.",no:"Unknown regime or unstable flip-zone behavior.",source:"SpotGamma gamma regime, gamma flip, zero gamma and walls"},
  {id:"direction",label:"Direction / trend",go:"Orderly trend or, for a butterfly, a defined range supports the thesis.",no:"Conflicting timeframes, violent headlines, or repeated reversals.",source:"Barchart Technical Opinion, moving averages; TrendSpider"},
  {id:"vwap",label:"Price versus VWAP",go:"Price holds VWAP in the intended direction.",no:"Repeated VWAP crosses or price moving against the thesis.",source:"Barchart or broker intraday VWAP chart"},
  {id:"momentum",label:"Momentum",go:"RSI and MACD support or improve with the setup.",no:"Fading or diverging momentum; an immediate reversal is required.",source:"Barchart RSI, MACD and ROC"},
  {id:"expected_move",label:"Expected move",go:"Target is realistically reachable within the expected move.",no:"An oversized or low-probability move is needed.",source:"Option-chain expected move; SpotGamma levels"},
  {id:"expiration",label:"Time to expiration",go:"Enough time for the thesis to develop without immediate precision.",no:"Too little time; a perfect immediate move is required.",source:"Option-chain DTE and Greeks"},
  {id:"reward",label:"Planned reward / risk",go:"Approximately 1.5:1 or better under the planned management, not just the theoretical ceiling.",no:"Planned payoff does not justify debit and risk.",source:"Option chain or broker ticket: debit, max profit, max loss"},
  {id:"events",label:"Event risk",go:"No unplanned binary event likely to invalidate the setup.",no:"Fed, CPI, earnings, jobs or geopolitical risk could invalidate it.",source:"Economic, earnings and news calendars"},
] as const;
export const CHECKLISTS = {
  butterfly: [COMMON[0],
    {id:"flip",label:"Price versus gamma flip",go:"Price holds clearly on the positive-gamma side.",no:"Price sits on, crosses or repeatedly whipsaws around the flip.",source:"SpotGamma, EquityHub or index gamma levels"},
    {id:"volatility",label:"Volatility",go:"VIX stable or falling; no developing volatility shock.",no:"VIX or VVIX accelerating higher.",source:"Barchart VIX chart; CBOE if available"},
    COMMON[1],COMMON[2],
    {id:"averages",label:"Moving averages",go:"Price structure and key averages support the thesis.",no:"A major moving average directly blocks the expected path.",source:"Barchart Technical Analysis / Trader's Cheat Sheet"},
    COMMON[3],COMMON[4],
    {id:"path",label:"Support / resistance",go:"Target aligns with a support, resistance, wall or magnet level.",no:"A major support/resistance or options wall blocks the path.",source:"SpotGamma call/put walls; Barchart support/resistance"},
    COMMON[5],COMMON[6],COMMON[7]],
  debit_spread: [COMMON[0],COMMON[1],COMMON[2],COMMON[3],
    {id:"path",label:"Gamma levels / path",go:"Room to travel toward the short strike without an immediate major options barrier.",no:"A call/put wall or major gamma level directly conflicts with the thesis.",source:"SpotGamma / EquityHub levels; Barchart OI by strike"},
    {id:"strikes",label:"Strike selection",go:"Long strike participates in the move; short strike near a realistic target or level.",no:"Both strikes need an outsized move, or the short strike is beyond a major barrier.",source:"Option-chain Greeks, delta, OI; SpotGamma levels"},
    {id:"iv",label:"Implied volatility",go:"IV is reasonable and the debit is not excessively inflated.",no:"Unusually elevated IV without a catalyst-aware reason or overpriced relative payoff.",source:"Barchart IV rank/percentile if available; option chain"},
    COMMON[4],COMMON[6],COMMON[5],
    {id:"liquidity",label:"Liquidity",go:"Tight bid/ask and healthy volume and open interest on both strikes.",no:"Wide bid/ask, thin OI, or difficult fills.",source:"Barchart bid/ask, volume and OI"},
    COMMON[7]],
} as const;
export const reviewSchema = z.object({
  symbol:z.enum(["QQQ","SPY"]), strategy:z.enum(["butterfly","debit_spread"]),
  direction:z.enum(["bullish","bearish","range","unknown"]),
  gamma:z.enum(["positive","negative","unknown"]),
  flipChop:z.enum(["yes","no","unknown"]),
  strongConfirmation:z.enum(["yes","no","unknown"]),
  checks:z.record(z.string(),z.enum(["go","no","unknown"])),
  evidence:z.string().trim().min(10).max(4000),
}).strict();
export type ReviewInput = z.infer<typeof reviewSchema>;
export function evaluateReview(input:ReviewInput) {
  const blockers:string[]=[],missing:string[]=[];
  for(const check of CHECKLISTS[input.strategy]) {
    const answer=input.checks[check.id]??"unknown";
    if(answer==="no") blockers.push(check.label);
    if(answer==="unknown") missing.push(check.label);
  }
  if(input.gamma==="unknown") missing.push("Gamma regime not known");
  if(input.flipChop==="unknown") missing.push("Flip-zone behavior not known");
  if(input.flipChop==="yes") blockers.push("Chopping around the gamma flip: wait");
  if(input.direction==="unknown") missing.push("Direction not known");
  if(input.strategy==="butterfly" && input.gamma==="negative") blockers.push("Negative gamma: no standard beginner butterfly");
  if(input.strategy==="debit_spread") {
    if(input.direction==="range") blockers.push("A debit spread requires a clear bullish or bearish thesis");
    if(input.gamma==="negative" && input.strongConfirmation!=="yes") blockers.push("Negative gamma requires stronger directional confirmation");
  }
  return {status:blockers.length?"no_go":missing.length?"incomplete":"go",blockers,missing,
    message:blockers.length?"Wait / no trade for this strategy.":missing.length?"Missing evidence: do not assume a pass.":"Checklist passed for planning; not a trade instruction or execution authorization."};
}
export function currentReview(review:any,now=new Date()) {
  if(!review)return false;
  const age=now.getTime()-new Date(review.createdAt).getTime();
  return Number.isFinite(age)&&age>=0&&age<=REVIEW_MINUTES*60_000&&review.version===CHECKLIST_VERSION;
}
export const layerSchema=z.object({
  optionType:z.enum(["call","put"]), expiration:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  longStrike:z.number().positive(),shortStrike:z.number().positive(),
  contracts:z.number().int().min(1).max(1000),debit:z.number().positive(),
  targetCredit:z.number().positive(),stopCredit:z.number().nonnegative(),
  addTrigger:z.string().trim().min(10).max(1000),
}).strict();
export const layerPlanSchema=z.object({
  symbol:z.enum(["QQQ","SPY"]),direction:z.enum(["bullish","bearish"]),
  riskCap:z.number().positive(),maxLayers:z.number().int().min(1).max(10),
  thesis:z.string().trim().min(10).max(2000),
  layers:z.array(layerSchema).min(1).max(10),
}).strict();
export type LayerPlan=z.infer<typeof layerPlanSchema>;
export function calculateLayerPlan(plan:LayerPlan) {
  const issues:string[]=[];
  if(plan.layers.length>plan.maxLayers)issues.push("Layer count exceeds the operator's declared limit");
  const layers=plan.layers.map((l,i)=>{
    const width=Math.abs(l.longStrike-l.shortStrike);
    if((l.optionType==="call")!==(plan.direction==="bullish") ||
       (l.optionType==="call"?l.longStrike>=l.shortStrike:l.longStrike<=l.shortStrike))issues.push(`Layer ${i+1}: invalid direction or long/short strike ordering`);
    if(l.debit>=width || l.targetCredit>width || l.targetCredit<=l.debit || l.stopCredit>=l.debit)
      issues.push(`Layer ${i+1}: debit, target or stop outside valid spread bounds`);
    const expiry=new Date(`${l.expiration}T00:00:00Z`);
    if(!Number.isFinite(expiry.getTime())||expiry.toISOString().slice(0,10)!==l.expiration)issues.push(`Layer ${i+1}: invalid expiration`);
    const maxLoss=l.debit*100*l.contracts,maxProfit=(width-l.debit)*100*l.contracts;
    const plannedProfit=(l.targetCredit-l.debit)*100*l.contracts,plannedLoss=(l.debit-l.stopCredit)*100*l.contracts;
    const plannedRR=plannedLoss>0?plannedProfit/plannedLoss:0;
    if(plannedRR<1.5)issues.push(`Layer ${i+1}: planned reward/risk is below 1.5:1`);
    return {...l,width,maxLoss,maxProfit,plannedProfit,plannedLoss,plannedRR,
      breakeven:l.optionType==="call"?l.longStrike+l.debit:l.longStrike-l.debit};
  });
  const totalMaxLoss=layers.reduce((s,l)=>s+l.maxLoss,0),totalMaxProfit=layers.reduce((s,l)=>s+l.maxProfit,0);
  if(totalMaxLoss>plan.riskCap+0.00001)issues.push("Combined full-debit risk exceeds the operator's risk cap");
  return {layers,totalMaxLoss,totalMaxProfit,issues,valid:issues.length===0,
    warning:"Planning only, not positions or fills. Stops are not guaranteed; risk uses the entire debit. Sum of individual maximum profits is not a guaranteed simultaneous portfolio payoff. Excludes fees/slippage."};
}
