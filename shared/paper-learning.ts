import {z} from "zod";
export const spreadRuleSchema=z.object({
  enabled:z.boolean(),
  triggers:z.array(z.object({comparison:z.enum(["above","below"]),spot:z.number().positive()}).strict()).min(1).max(10),
  feePerContractLeg:z.number().min(0).max(10).default(0.65),
  slippagePerSpread:z.number().min(0).max(1).default(0.02),
}).strict();
export type SpreadRules=z.infer<typeof spreadRuleSchema>;
export function spreadQuote(chain:any,layer:any) {
  const leg=(strike:number)=>chain?.options?.find((o:any)=>o.strike===strike&&o.expiration===layer.expiration&&o.type===layer.optionType);
  const long=leg(layer.longStrike),short=leg(layer.shortStrike),width=Math.abs(layer.longStrike-layer.shortStrike);
  for(const l of [long,short])if(!l||![l.bid,l.ask].every(Number.isFinite)||l.bid<=0||l.ask<l.bid)throw Error("Both legs need positive, uncrossed bid/ask quotes");
  const entry=long.ask-short.bid,exit=long.bid-short.ask;
  if(entry<=0||entry>=width||exit<0||exit>width)throw Error("Executable spread quote outside payoff bounds");
  return {entry,exit,width,timestamp:chain.timestamp,spot:chain.spot};
}
export function learningSummary(positions:any[]) {
  const closed=positions.filter(p=>p.status==="closed"),wins=closed.filter(p=>Number(p.realized_pnl)>0);
  const profit=wins.reduce((s,p)=>s+Number(p.realized_pnl),0);
  const loss=-closed.filter(p=>Number(p.realized_pnl)<0).reduce((s,p)=>s+Number(p.realized_pnl),0);
  return {closed:closed.length,open:positions.filter(p=>p.status==="open").length,
    realizedNet:closed.reduce((s,p)=>s+Number(p.realized_pnl),0),
    winRate:closed.length?wins.length/closed.length:null,profitFactor:loss>0?profit/loss:null,
    caveat:"Paper spread results only; quoted bid/ask plus configured costs, not broker fills. Small samples and selection bias do not establish an edge."};
}
