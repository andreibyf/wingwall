import {test} from "node:test";
import assert from "node:assert/strict";
import {recommendationDraftSchema,draftTool} from "../shared/recommendation-draft";
import {requestCopilotReply} from "../server/copilot-response";
const draft={title:"Wait for evidence",symbol:"QQQ",strategy:"wait",direction:"unknown",
  thesis:"Conditional plan only",entryCondition:"Verify tape",exitPlan:"Not set",invalidation:"Missing confirmation",
  riskCap:null,suggestedDebit:null,targetCredit:null,stopCredit:null,legs:[],evidence:[],missingEvidence:["Current quote timestamps"]};
test("incomplete drafts preserve unknown values, and tool exposes structured fields",()=>{
  assert.deepEqual(recommendationDraftSchema.parse(draft),draft);
  assert.equal(draftTool.input_schema.type,"object");
});
test("execution and approval fields are forbidden",()=>{
  for(const field of ["enabled","autoTradeEnabled","status","checks","execute"])
    assert.equal(recommendationDraftSchema.safeParse({...draft,[field]:true}).success,false);
  assert.equal(recommendationDraftSchema.safeParse({...draft,riskCap:-1}).success,false);
});
test("completed draft tool persists once and returns server-owned acknowledgment",async()=>{
  let writes=0;
  const r=await requestCopilotReply(async()=>({stop_reason:"tool_use",content:[
    {type:"text",text:"I executed a trade"}, {type:"tool_use",name:draftTool.name,input:draft}
  ]}),8192,"test",async input=>{writes++;recommendationDraftSchema.parse(input);return{id:1};});
  assert.equal(writes,1);assert.deepEqual(r.draft,{id:1});assert.doesNotMatch(r.reply,/I executed/);
});
test("truncated, unknown, multiple or malformed tools never save",async()=>{
  for(const response of [
    {stop_reason:"max_tokens",content:[{type:"tool_use",name:draftTool.name,input:draft}]},
    {stop_reason:"tool_use",content:[{type:"tool_use",name:"execute_trade",input:draft}]},
    {stop_reason:"tool_use",content:[{type:"tool_use",name:draftTool.name,input:draft},{type:"tool_use",name:draftTool.name,input:draft}]},
    {stop_reason:"end_turn",content:[{type:"tool_use",name:draftTool.name,input:draft},{type:"text",text:"saved"}]},
  ]) {
    let writes=0;await assert.rejects(requestCopilotReply(async()=>response,8192,"test",async()=>{writes++;}));
    assert.equal(writes,0);
  }
  await assert.rejects(requestCopilotReply(async()=>({stop_reason:"tool_use",content:[{type:"tool_use",name:draftTool.name,input:{execute:true}}]}),8192,"test",async input=>recommendationDraftSchema.parse(input)));
});
test("database failures cannot produce a false saved confirmation",async()=>{
  await assert.rejects(requestCopilotReply(async()=>({stop_reason:"tool_use",content:[{type:"tool_use",name:draftTool.name,input:draft}]}),8192,"test",async()=>{throw Error("database failed");}),/database failed/);
});
