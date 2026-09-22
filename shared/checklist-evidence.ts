import {CHECKLISTS,type Strategy} from "./strategy-policy";

export type EvidenceItem={
  id:string; label:string; value:string; source:string; observedAt:string|null;
  retrievedAt:string|null; status:"current"|"stale"|"unverified"|"missing"|"proposal";
  detail:string;
};
export type ChecklistEvidence={
  symbol:string;strategy:Strategy;generatedAt:string;items:EvidenceItem[];
  draftId:number|null;warning:string;
};
// Explicit timestamp zones only. Never turn a fetch time into an observation time.
export function evidenceTime(value:unknown):string|null {
  if(value instanceof Date)return Number.isFinite(value.getTime())?value.toISOString():null;
  if(typeof value!=="string"||!/(Z|[+-]\d\d:\d\d)$/.test(value))return null;
  const n=Date.parse(value);return Number.isFinite(n)?new Date(n).toISOString():null;
}
export function evidenceStatus(time:string|null,now:Date,maxAge:number):EvidenceItem["status"] {
  if(!time)return "unverified";
  const age=now.getTime()-Date.parse(time);
  return age < -30_000?"unverified":age>maxAge?"stale":"current";
}
const missing:Record<string,string>={
  gamma:"No usable cached Gexbot net-GEX observation.",
  flip:"Needs a gamma-flip level and timestamp-aligned price history to verify a hold.",
  volatility:"VIX/VVIX time-series feed is not connected.",
  direction:"Intraday/daily price history and trend rules are not connected.",
  vwap:"Session price/volume history and VWAP calculation are not connected.",
  averages:"Historical prices and selected moving-average periods are not connected.",
  momentum:"Historical prices and RSI/MACD calculations are not connected.",
  expected_move:"Select a draft with one known expiration; valid spot and ATM IV are required.",
  expiration:"Select a draft with a known expiration.",
  path:"Needs relevant levels plus a selected target and price history.",
  reward:"Needs complete selected strikes, debit, size, target, stop and costs.",
  events:"Economic/earnings calendar and news feeds are not connected.",
  strikes:"Select a draft with known strikes and expiration; direction/path still require review.",
  iv:"Current option IV needs valid selected contracts; historical IV rank is not connected.",
  liquidity:"Select complete legs to inspect bid/ask, volume and OI. Fresh quotes remain required.",
};
export function buildChecklistEvidence(input:{
  symbol:string;strategy:Strategy;now?:Date;gex?:any;chain?:any;draft?:any;
  gexError?:boolean;chainError?:boolean;
}):ChecklistEvidence {
  const {symbol,strategy,gex,chain,draft}=input,now=input.now??new Date();
  const generatedAt=now.toISOString();
  const items:EvidenceItem[]=[
    {id:"thesis",label:"Thesis direction",value:"Unknown",source:"Selected recommendation draft",observedAt:null,retrievedAt:null,status:"missing",detail:"Select a draft to show its proposed thesis; this is not measured trend."},
    {id:"flipChop",label:"Chopping around flip?",value:"Unknown",source:"Not connected",observedAt:null,retrievedAt:null,status:"missing",detail:"Requires timestamped price history and crossing rules. One spot reading cannot establish chop."},
    ...CHECKLISTS[strategy].map(c=>({id:c.id,label:c.label,value:"Unknown",source:"Not connected",observedAt:null,retrievedAt:null,status:"missing" as const,detail:missing[c.id]})),
  ];
  if(strategy==="debit_spread")items.push({id:"strongConfirmation",label:"Stronger directional confirmation",value:"Unknown",source:"Not connected",observedAt:null,retrievedAt:null,status:"missing",detail:"Needs defined confirmation rules and trend/momentum evidence."});
  const set=(id:string,patch:Partial<EvidenceItem>)=>{const item=items.find(v=>v.id===id);if(item)Object.assign(item,patch);};
  const validNum=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
  // Cache rows are symbol-scoped; do not mix symbols even if a caller misroutes a row.
  if(gex?.symbol===symbol) {
    const ts=validNum(gex.providerTimestamp)&&gex.providerTimestamp>0?evidenceTime(new Date(gex.providerTimestamp*1000)):null;
    const meta={source:`Gexbot ${gex.category??"unknown category"} (cached OI model)`,observedAt:ts,retrievedAt:evidenceTime(gex.fetchedAt),
      status:evidenceStatus(ts,now,30*60_000)};
    if(validNum(gex.netGexOi))set("gamma",{...meta,value:gex.netGexOi>0?"Positive":gex.netGexOi<0?"Negative":"Neutral / unresolved",
      detail:"Derived from signed net GEX, not unsigned gamma-weighted OI. 30-minute suggestion freshness policy; not checklist approval."});
    if(validNum(gex.gammaFlip))set("flip",{...meta,value:`Gamma flip ${gex.gammaFlip}`,detail:"Reference level only. A stable hold and positive-gamma side are not established without aligned price history."});
    if(validNum(gex.callWall)||validNum(gex.putWall))set("path",{...meta,value:`Positive-GEX level: ${validNum(gex.callWall)?gex.callWall:"unknown"}; negative-GEX level: ${validNum(gex.putWall)?gex.putWall:"unknown"}`,
      detail:"Provider model levels, not necessarily tradable strikes. Target alignment/path is not yet approved."});
  } else if(input.gexError) set("gamma",{detail:"Gexbot cache could not be read. No replacement level was invented."});
  const p=draft?.payload;
  const draftMatches=p?.symbol===symbol&&(p.strategy===strategy||p.strategy==="wait");
  const draftTime=evidenceTime(draft?.updatedAt??draft?.createdAt);
  if(draftMatches)set("thesis",{value:p.direction??"unknown",source:`Draft #${draft.id} (unverified proposal)`,status:"proposal",observedAt:draftTime,retrievedAt:generatedAt,
    detail:p.strategy==="wait"?"WAIT draft: does not endorse this strategy. Timestamp is the draft edit time, not market observation.":"Proposed direction only. Timestamp is the draft edit time, not market observation."});
  const legs=draftMatches&&p.strategy===strategy&&Array.isArray(p.legs)?p.legs:[];
  const dates=Array.from(new Set<string>(legs.map((l:any)=>l.expiration).filter((d:any)=>typeof d==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(d))));
  const parsedDate=dates.length===1?evidenceTime(dates[0]+"T00:00:00Z"):null;
  const date=parsedDate?.slice(0,10)===dates[0]&&legs.every((l:any)=>l.expiration===dates[0])?dates[0]:null;
  const etDay=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
  const dte=date?Math.round((Date.parse(date+"T00:00:00Z")-Date.parse(etDay+"T00:00:00Z"))/86400000):null;
  if(date&&dte!==null&&Number.isFinite(dte))set("expiration",{value:`${date} · ${dte} calendar day(s) remaining`,source:`Draft #${draft.id} + Eastern calendar`,status:"proposal",observedAt:draftTime,retrievedAt:generatedAt,
    detail:dte<0?"Expiration is in the past. Do not use this setup.":"Calendar days, not trading sessions. Time sufficiency still needs your thesis and review."});
  if(chain?.symbol===symbol) {
    const quoteTime=evidenceTime(chain.timestamp);
    // This adapter is explicitly delayed; even a recent timestamp cannot certify realtime.
    const ageStatus=evidenceStatus(quoteTime,now,120_000);
    const meta={source:"Cboe delayed option-chain snapshot",observedAt:quoteTime,retrievedAt:generatedAt,status:ageStatus==="current"?"unverified" as const:ageStatus};
    const opts=Array.isArray(chain.options)?chain.options:[];
    if(date&&dte!==null&&dte>0&&validNum(chain.spot)&&chain.spot>0){
      const contracts=opts.filter((o:any)=>o.expiration===date&&validNum(o.strike)&&validNum(o.iv)&&o.iv>0);
      contracts.sort((a:any,b:any)=>Math.abs(a.strike-chain.spot)-Math.abs(b.strike-chain.spot));
      const atm=contracts[0]?.strike;
      const atms=contracts.filter((o:any)=>o.strike===atm);
      if(atms.length){
        const iv=atms.reduce((sum:number,o:any)=>sum+o.iv,0)/atms.length;
        const move=chain.spot*iv*Math.sqrt(dte/365);
        set("expected_move",{...meta,value:`Illustrative ±${move.toFixed(2)} to ${date}`,detail:`ATM IV ${(iv*100).toFixed(1)}%; spot ${chain.spot}; calendar-day/365 approximation. Delayed context only, not a probability guarantee or target approval.`});
      }
    }
    const matched=legs.map((l:any)=>opts.find((o:any)=>o.expiration===l.expiration&&o.strike===l.strike&&o.type===l.optionType));
    if(legs.length&&matched.every(Boolean)){
      set("strikes",{...meta,value:legs.map((l:any)=>`${l.side} ${l.optionType} ${l.strike}`).join("; "),detail:"Selected draft legs exist in this snapshot. Participation, barriers and suitability still need review."});
      set("liquidity",{...meta,value:matched.map((o:any)=>`${o.strike} ${o.type}: bid ${o.bid??"?"} / ask ${o.ask??"?"}, vol ${o.volume??"?"}, OI ${o.openInterest??"?"}`).join("; "),
        detail:"Delayed snapshot, not executable quotes. Zero, missing or crossed bid/ask is not a usable market. No GO suggested."});
      set("iv",{...meta,value:matched.map((o:any)=>`${o.strike}: ${validNum(o.iv)&&o.iv>0?(o.iv*100).toFixed(1)+"%":"unknown"}`).join("; "),
        detail:"Current snapshot IV only; historical rank/percentile and relative-expensiveness assessment are unavailable."});
    }
  } else if(input.chainError) {
    for(const id of ["expected_move","iv","liquidity","strikes"])set(id,{detail:"Option-chain request failed. No remembered or estimated quote substituted."});
  }
  return {symbol,strategy,generatedAt,draftId:draftMatches?draft.id:null,items,
    warning:"Suggested evidence only. No checklist answers, approvals, automation settings or positions are changed. Stale/delayed observations cannot establish current conditions."};
}
