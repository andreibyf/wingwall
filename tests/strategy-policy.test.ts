import {test} from "node:test";
import assert from "node:assert/strict";
import {CHECKLISTS,CHECKLIST_VERSION,evaluateReview,currentReview,calculateLayerPlan,layerPlanSchema,reviewSchema,type Strategy,type ReviewInput,type LayerPlan} from "../shared/strategy-policy";
const review=(strategy:Strategy="butterfly"):ReviewInput=>({symbol:"QQQ",strategy,gamma:"positive",flipChop:"no",strongConfirmation:"unknown",direction:"bullish",checks:Object.fromEntries(CHECKLISTS[strategy].map(c=>[c.id,"go"])),evidence:"Operator chart observations with source and time"});
const plan=():LayerPlan=>({symbol:"QQQ",direction:"bullish",riskCap:200,maxLayers:2,thesis:"Trend continuation after a confirmed retest",
  layers:[{optionType:"call",expiration:"2026-09-24",longStrike:100,shortStrike:105,contracts:1,debit:1,targetCredit:3,stopCredit:0.5,addTrigger:"Hold above VWAP after retest"}]});
test("each mentor checklist has all twelve checks",()=>{assert.equal(CHECKLISTS.butterfly.length,12);assert.equal(CHECKLISTS.debit_spread.length,12);});
test("positive gamma alone never implies GO",()=>assert.equal(evaluateReview({...review(),checks:{}}).status,"incomplete"));
test("negative gamma hard-blocks butterflies even with all GO boxes",()=>assert.equal(evaluateReview({...review(),gamma:"negative"}).status,"no_go"));
test("negative gamma spread needs explicit stronger confirmation",()=>{
  const r={...review("debit_spread"),gamma:"negative" as const};
  assert.equal(evaluateReview(r).status,"no_go");assert.equal(evaluateReview({...r,strongConfirmation:"yes"}).status,"go");
});
test("flip chop blocks both strategies; switching is not permission",()=>{
  for(const strategy of ["butterfly","debit_spread"] as const)assert.equal(evaluateReview({...review(strategy),flipChop:"yes"}).status,"no_go");
});
test("any NO-GO blocks even with eleven passed checks",()=>assert.equal(evaluateReview({...review(),checks:{...review().checks,events:"no"}}).status,"no_go"));
test("range thesis disallows directional spread",()=>assert.equal(evaluateReview({...review("debit_spread"),direction:"range"}).status,"no_go"));
test("unknown regime or flip behavior never passes",()=>{
  assert.equal(evaluateReview({...review(),gamma:"unknown"}).status,"incomplete");
  assert.equal(evaluateReview({...review(),flipChop:"unknown"}).status,"incomplete");
});
test("review requires written evidence and recognized values",()=>assert.equal(reviewSchema.safeParse({...review(),evidence:""}).success,false));
test("review TTL rejects stale, future, old version and missing records",()=>{
  const now=new Date("2026-09-22T14:00:00Z"),r={version:CHECKLIST_VERSION,createdAt:now.toISOString()};
  assert.equal(currentReview(r,now),true);assert.equal(currentReview(null,now),false);
  assert.equal(currentReview({...r,createdAt:"2026-09-22T13:29:00Z"},now),false);
  assert.equal(currentReview({...r,createdAt:"2026-09-22T14:01:00Z"},now),false);
  assert.equal(currentReview({...r,version:"old"},now),false);
});
test("bull call spread math uses debit risk and planned management",()=>{
  const c=calculateLayerPlan(plan());assert.equal(c.valid,true);assert.equal(c.totalMaxLoss,100);
  assert.equal(c.totalMaxProfit,400);assert.equal(c.layers[0].breakeven,101);assert.equal(c.layers[0].plannedRR,4);
});
test("bear put spread direction and breakeven",()=>{
  const p=plan();p.direction="bearish";p.layers[0]={...p.layers[0],optionType:"put",longStrike:105,shortStrike:100};
  const c=calculateLayerPlan(p);assert.equal(c.valid,true);assert.equal(c.layers[0].breakeven,104);
});
test("layering sums maximum loss without stop or diversification discounts",()=>{
  const p=plan();p.layers.push({...p.layers[0]});assert.equal(calculateLayerPlan(p).totalMaxLoss,200);
  p.riskCap=199;assert.equal(calculateLayerPlan(p).valid,false);
});
test("layer cap, wrong direction, credit spread and theoretical-only payoff are rejected",()=>{
  let p=plan();p.maxLayers=1;p.layers.push({...p.layers[0]});assert.equal(calculateLayerPlan(p).valid,false);
  p=plan();p.direction="bearish";assert.equal(calculateLayerPlan(p).valid,false);
  p=plan();p.layers[0].debit=5;assert.equal(calculateLayerPlan(p).valid,false);
  p=plan();p.layers[0].targetCredit=1.1;assert.equal(calculateLayerPlan(p).valid,false);
});
test("date, over-width target and stop above debit are rejected",()=>{
  for(const patch of [{expiration:"2026-99-99"},{expiration:"2026-02-30"},{targetCredit:6},{stopCredit:2}]) {
    const p=plan();Object.assign(p.layers[0],patch);assert.equal(calculateLayerPlan(p).valid,false);
  }
});
test("plans reject fractional contracts, unknown keys and absent triggers",()=>{
  for(const patch of [{contracts:1.5},{addTrigger:""},{brokerOrder:true}]) {
    const p=plan();Object.assign(p.layers[0],patch);assert.equal(layerPlanSchema.safeParse(p).success,false);
  }
});
