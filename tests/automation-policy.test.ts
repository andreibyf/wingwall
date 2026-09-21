import assert from "node:assert/strict";
import { test } from "node:test";
import {entryWindow,session,eastern,freshQuote,exitReason,marketOpen,remainingSessions} from "../server/automation-policy";

for(const [iso,allowed] of [
  ["2026-09-21T13:44:59Z",false],["2026-09-21T13:45:00Z",true],
  ["2026-09-21T14:29:59Z",true],["2026-09-21T14:30:00Z",false],
  ["2026-09-21T22:00:00Z",false],["2026-09-24T14:00:00Z",false],
  ["2026-09-25T14:00:00Z",false],["2026-09-26T14:00:00Z",false],
  ["2026-09-07T14:00:00Z",false],["2026-09-08T14:00:00Z",true],
  ["2026-03-02T14:45:00Z",true],["2026-03-09T13:45:00Z",true],
  ["2026-11-02T14:45:00Z",true],["2026-11-02T13:45:00Z",false],
  ["2026-11-23T15:00:00Z",false],["2028-01-03T15:00:00Z",false],
] as const) test(`entry window ${iso}`,()=>assert.equal(entryWindow(new Date(iso)).allowed,allowed));
test("Tuesday after holiday remains Monday-keyed with fewer sessions",()=>{
  assert.equal(entryWindow(new Date("2026-09-08T14:00:00Z")).monday,"2026-09-07");
  assert.equal(remainingSessions("2026-09-08","2026-09-10"),2);
});
test("Eastern date does not roll at UTC midnight",()=>assert.equal(eastern(new Date("2026-09-22T00:30:00Z")).date,"2026-09-21"));
test("early close and unknown year fail closed",()=>{
  assert.equal(session("2026-12-24").close,780);
  assert.equal(marketOpen(new Date("2026-12-24T18:00:00Z")),false);
  assert.equal(session("2028-01-03").supported,false);
});
test("freshness rejects unknown timezone, absent, future and stale observations",()=>{
  const now=new Date("2026-09-21T14:00:00Z");
  for(const value of [undefined,"","2026-09-21T14:00:00","2026-09-21T13:57:59Z","2026-09-21T14:01:00Z"])assert.equal(freshQuote(value,now),false);
  assert.equal(freshQuote("2026-09-21T13:58:00Z",now),true);
});
const fly={entryDebit:1,maxLoss:100,maxProfit:400,contracts:1,expiration:"2026-09-24"};
const policy={takeProfitMode:"multipleOfDebit",takeProfitValue:2,stopLossPctOfMaxLoss:-0.4};
test("profit and loss thresholds, zero price, and market hours",()=>{
  const now=new Date("2026-09-21T14:00:00Z");
  assert.equal(exitReason(fly,2,policy,now),"take-profit");
  assert.equal(exitReason(fly,0.6,policy,now),"stop-loss");
  assert.equal(exitReason(fly,0,policy,now),"stop-loss");
  assert.equal(exitReason(fly,1.5,policy,now),null);
  assert.equal(exitReason(fly,NaN,policy,now),null);
  assert.equal(exitReason(fly,2,policy,new Date("2026-09-21T22:00:00Z")),null);
});
test("expiry and Friday curfews honor early closes; expired requires manual review",()=>{
  assert.equal(exitReason(fly,1,policy,new Date("2026-09-24T19:45:00Z")),"expiry-curfew");
  assert.equal(exitReason({...fly,expiration:"2026-12-31"},1,policy,new Date("2026-11-27T17:45:00Z")),"friday-curfew");
  assert.equal(exitReason({...fly,expiration:"2026-10-01"},1,policy,new Date("2026-09-25T18:00:00Z")),"friday-curfew");
  assert.equal(exitReason(fly,1,policy,new Date("2026-09-25T18:00:00Z")),null);
});
