import {test} from "node:test";
import assert from "node:assert/strict";
import {spreadQuote,spreadRuleSchema,learningSummary} from "../shared/paper-learning";
const layer={longStrike:100,shortStrike:105,expiration:"2026-09-24",optionType:"call"};
const chain={timestamp:"2026-09-21T14:00:00Z",spot:101,options:[
  {strike:100,expiration:layer.expiration,type:"call",bid:2,ask:2.1},
  {strike:105,expiration:layer.expiration,type:"call",bid:1,ask:1.1}]};
test("spread pricing uses executable bid/ask sides, not optimistic midpoint",()=>{
  const q=spreadQuote(chain,layer);assert.ok(Math.abs(q.entry-1.1)<1e-9);assert.ok(Math.abs(q.exit-.9)<1e-9);
});
test("missing, zero, crossed and nonfinite leg quotes fail closed",()=>{
  for(const bid of [0,NaN,3])assert.throws(()=>spreadQuote({...chain,options:[{...chain.options[0],bid},chain.options[1]]},layer));
  assert.throws(()=>spreadQuote({...chain,options:[]},layer));
});
test("automation rejects absent numeric triggers and invalid costs",()=>{
  assert.equal(spreadRuleSchema.safeParse({enabled:true,triggers:[]}).success,false);
  assert.equal(spreadRuleSchema.safeParse({enabled:true,triggers:[{comparison:"above",spot:100}],feePerContractLeg:-1}).success,false);
});
test("profitability includes losses and break-even observations without inventing infinite factor",()=>{
  const s=learningSummary([{status:"closed",realized_pnl:100},{status:"closed",realized_pnl:-50},{status:"closed",realized_pnl:0},{status:"open"}]);
  assert.equal(s.realizedNet,50);assert.equal(s.winRate,1/3);assert.equal(s.profitFactor,2);assert.equal(s.open,1);
  assert.equal(learningSummary([]).winRate,null);assert.equal(learningSummary([{status:"closed",realized_pnl:1}]).profitFactor,null);
});
