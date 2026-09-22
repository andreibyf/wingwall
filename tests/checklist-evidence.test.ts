import {test} from "node:test";
import assert from "node:assert/strict";
import {buildChecklistEvidence,evidenceTime} from "../shared/checklist-evidence";
const now=new Date("2026-09-22T16:00:00Z");
const base={symbol:"QQQ",strategy:"butterfly" as const,now};
const gamma={symbol:"QQQ",category:"gex_full",providerTimestamp:now.getTime()/1000,fetchedAt:now.toISOString(),netGexOi:100,gammaFlip:700,callWall:720,putWall:690};
const item=(r:ReturnType<typeof buildChecklistEvidence>,id:string)=>r.items.find(i=>i.id===id)!;
test("missing feeds keep every checklist field unknown with a reason",()=>{
  const r=buildChecklistEvidence(base);
  assert.ok(r.items.every(i=>i.value==="Unknown"&&i.status==="missing"&&i.detail));
  assert.equal(item(r,"vwap").observedAt,null);
  assert.match(r.warning,/No checklist answers/);
});
test("gamma uses signed provider net GEX, preserves source and fetch times",()=>{
  const r=buildChecklistEvidence({...base,gex:gamma});
  assert.equal(item(r,"gamma").value,"Positive");
  assert.equal(item(r,"gamma").status,"current");
  assert.equal(item(r,"gamma").observedAt,now.toISOString());
  assert.equal(item(r,"flipChop").value,"Unknown");
  assert.equal(item(r,"gamma").retrievedAt,now.toISOString());
});
test("stale observations are not rejuvenated by current fetch times",()=>{
  const r=buildChecklistEvidence({...base,gex:{...gamma,providerTimestamp:(now.getTime()-3600_000)/1000}});
  assert.equal(item(r,"gamma").status,"stale");
});
test("absent, invalid and future provider timestamps are unverified",()=>{
  for(const providerTimestamp of [null,NaN,1e30,(now.getTime()+60_000)/1000]){
    assert.equal(item(buildChecklistEvidence({...base,gex:{...gamma,providerTimestamp}}),"gamma").status,"unverified");
  }
  assert.equal(evidenceTime("2026-09-22T12:00:00"),null);
});
test("neutral is not relabeled positive; mismatched symbols are not used",()=>{
  assert.equal(item(buildChecklistEvidence({...base,gex:{...gamma,netGexOi:0}}),"gamma").value,"Neutral / unresolved");
  assert.equal(item(buildChecklistEvidence({...base,gex:{...gamma,symbol:"SPY"}}),"gamma").value,"Unknown");
});
const draft={id:3,updatedAt:new Date("2026-09-22T15:00:00Z"),payload:{symbol:"QQQ",strategy:"debit_spread",direction:"bullish",legs:[
  {side:"buy",optionType:"call",strike:700,expiration:"2026-09-24"},
  {side:"sell",optionType:"call",strike:705,expiration:"2026-09-24"},
]}};
const chain={symbol:"QQQ",spot:700,timestamp:now.toISOString(),options:[
  {type:"call",strike:700,expiration:"2026-09-24",iv:.2,bid:4,ask:5,volume:100,openInterest:1000},
  {type:"call",strike:705,expiration:"2026-09-24",iv:.21,bid:2,ask:3,volume:80,openInterest:500},
]};
test("matching draft supplies proposal and DTE; delayed data never becomes certified current",()=>{
  const r=buildChecklistEvidence({...base,strategy:"debit_spread",draft,chain});
  assert.equal(item(r,"thesis").status,"proposal");
  assert.equal(item(r,"thesis").observedAt,draft.updatedAt.toISOString());
  assert.match(item(r,"expiration").value,/2 calendar/);
  assert.match(item(r,"expected_move").value,/Illustrative/);
  assert.equal(item(r,"expected_move").status,"unverified");
  assert.match(item(r,"liquidity").value,/bid 4/);
  assert.equal(item(r,"reward").value,"Unknown");
  assert.equal(item(r,"strongConfirmation").value,"Unknown");
});
test("wait draft never supplies trade-leg evidence",()=>{
  const r=buildChecklistEvidence({...base,draft:{...draft,payload:{...draft.payload,strategy:"wait"}},chain});
  assert.match(item(r,"thesis").detail,/WAIT/);
  assert.equal(item(r,"expiration").value,"Unknown");
});
test("source outage and missing contracts keep gaps explicit; inputs never mutate",()=>{
  const original=structuredClone(draft);
  const r=buildChecklistEvidence({...base,strategy:"debit_spread",draft,chainError:true,gexError:true});
  assert.match(item(r,"liquidity").detail,/failed/);
  assert.deepEqual(draft,original);
  assert.equal(item(buildChecklistEvidence({...base,strategy:"debit_spread",draft,chain:{...chain,options:[]}}),"liquidity").value,"Unknown");
});
