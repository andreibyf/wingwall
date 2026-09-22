import assert from "node:assert/strict";
import {before,beforeEach,after,test} from "node:test";
import {Pool} from "pg";
import express from "express";
import {createServer,type Server} from "node:http";
import {once} from "node:events";
import {CHECKLISTS,CHECKLIST_VERSION} from "../shared/strategy-policy";

const url=new URL(process.env.TEST_DATABASE_URL??"postgresql://localhost:55432/postgres");
assert.equal(url.hostname,"localhost");assert.equal(url.pathname,"/postgres");assert.equal(url.search,"");
const name=`wingwall_automation_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:url.toString(),ssl:false});
let sql:Pool, appPool:Pool, server:Server, base:string;
let storage:any, commitEntry:any, commitExit:any, runWorker:any, runAuto:any, parseVerdict:any, workerStatus:any;
const now=new Date("2026-09-21T14:00:00Z");
const position={symbol:"QQQ",optionType:"put",structureType:"symmetric",expiration:"2026-09-24",
  lowerStrike:95,middleStrike:100,upperStrike:105,contracts:1,entryDebit:1,entryDate:"2026-09-21",
  status:"open",exitDebit:null,exitDate:null,maxLoss:100,maxProfit:400,campaignWallId:1,notes:"fixture",peakProfitPct:null,peakLossPct:null};

before(async()=>{
  await admin.query(`CREATE DATABASE "${name}"`);url.pathname=`/${name}`;
  process.env.DATABASE_URL=url.toString();
  process.env.WINGWALL_OPERATOR_PASSWORD="integration-only-passphrase";
  process.env.PAPER_AUTOMATION_MODE="paper";
  sql=new Pool({connectionString:url.toString(),ssl:false});
  const module=await import("../server/storage");storage=module.storage;appPool=module.db.$client;
  await module.ensureSchema();await module.ensureSchema();
  await storage.getSettings();
  ({commitPaperEntry:commitEntry,commitPaperExit:commitExit}=await import("../server/paper-ledger"));
  ({runPaperWorker:runWorker,workerStatus}=await import("../server/paper-worker"));
  ({runAutoTrade:runAuto,parseVerdict}=await import("../server/auto-trade"));
  const {installOperatorAuth}=await import("../server/operator-auth");
  const {registerRoutes}=await import("../server/routes");
  const app=express();app.use(express.json());installOperatorAuth(app);
  server=createServer(app);await registerRoutes(server,app);
  app.use((err:any,_req:any,res:any,_next:any)=>res.status(err.status??500).json({message:err.message}));
  server.listen(0,"127.0.0.1");await once(server,"listening");
  base=`http://127.0.0.1:${(server.address() as any).port}`;
});
beforeEach(async()=>{
  delete process.env.PAPER_AUTOMATION_FORCE_OBSERVE;
  await sql.query("UPDATE automation_control SET mode=NULL,version=1; TRUNCATE automation_mode_events");
  await sql.query("TRUNCATE recommendation_drafts RESTART IDENTITY");
  delete process.env.PAPER_ENTRY_ENABLED;
  process.env.PAPER_AUTOMATION_MODE="paper";delete process.env.PAPER_EXIT_ENABLED;
  process.env.WINGWALL_OPERATOR_PASSWORD="integration-only-passphrase";
  await sql.query(`DROP TRIGGER IF EXISTS reject_journal ON journal_notes;
    TRUNCATE flies,campaign_walls,journal_notes,paper_entry_claims,paper_worker_runs,operator_login_attempts RESTART IDENTITY;
    UPDATE settings SET auto_trade_enabled=true,default_symbol='QQQ',account_balance=1000,risk_per_trade_percent=10,
      take_profit_mode='multipleOfDebit',take_profit_value=2,stop_loss_pct_of_max_loss=-0.4;
    INSERT INTO campaign_walls (symbol,week_of,wall_price,active_branch,created_at)
      VALUES('QQQ','2026-09-21',100,'rejects','2026-09-21');`);
  await sql.query("TRUNCATE strategy_reviews,spread_plans,spread_decisions RESTART IDENTITY CASCADE");
  const review={symbol:"QQQ",strategy:"butterfly",gamma:"positive",direction:"bearish",flipChop:"no",strongConfirmation:"unknown",
    checks:Object.fromEntries(CHECKLISTS.butterfly.map(c=>[c.id,"go"])),evidence:"Test fixture only: all positive checklist evidence."};
  await sql.query("INSERT INTO strategy_reviews(symbol,strategy,payload,version,created_at) VALUES($1,$2,$3,$4,$5)",
    ["QQQ","butterfly",JSON.stringify(review),CHECKLIST_VERSION,now]);
});
after(async()=>{
  if(server?.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
  await appPool?.end();await sql?.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);await admin.end();
});
async function input() {return {fly:{...position},journal:"test-only",settingsSnapshot:await storage.getSettings(),
  wallSnapshot:(await storage.listCampaignWalls())[0],quoteTimestamp:now.toISOString(),now:()=>now};}
async function login(){
  const r=await fetch(`${base}/api/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:"integration-only-passphrase"})});
  assert.equal(r.status,200);return r.headers.get("set-cookie")!.split(";")[0];
}
test("checklist evidence is authenticated, read-only and tolerates feed failure",async()=>{
  const {registerChecklistEvidence}=await import("../server/checklist-evidence");
  const {installOperatorAuth}=await import("../server/operator-auth");
  const app=express();app.use(express.json());installOperatorAuth(app);
  let calls=0;
  registerChecklistEvidence(app,async()=>{calls++;throw Error("fixture outage");});
  const srv=createServer(app);srv.listen(0,"127.0.0.1");await once(srv,"listening");
  const endpoint=`http://127.0.0.1:${(srv.address() as any).port}/api/strategy/evidence?symbol=QQQ&strategy=butterfly`;
  try{
    assert.equal((await fetch(endpoint)).status,401);assert.equal(calls,0);
    const cookie=await login();
    const before=await sql.query("SELECT payload FROM strategy_reviews ORDER BY id");
    const settings=await storage.getSettings();
    const response=await fetch(endpoint,{headers:{cookie}});
    assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
    const body=await response.json();
    assert.equal(body.items.find((i:any)=>i.id==="expected_move").status,"missing");
    assert.match(body.items.find((i:any)=>i.id==="expected_move").detail,/request failed/);
    assert.equal((await fetch(endpoint+"&draftId=99999",{headers:{cookie}})).status,409);
    assert.equal(calls,1);
    assert.deepEqual((await sql.query("SELECT payload FROM strategy_reviews ORDER BY id")).rows,before.rows);
    assert.deepEqual(await storage.getSettings(),settings);
    assert.equal((await sql.query("SELECT count(*) FROM flies")).rows[0].count,"0");
  }finally{await new Promise<void>(resolve=>srv.close(()=>resolve()));}
});
test("recommendation drafts persist idempotently, edit with version checks and never touch trading state",async()=>{
  const {saveRecommendationDraft}=await import("../server/recommendation-drafts");
  const draft={title:"Conditional draft",symbol:"QQQ",strategy:"wait",direction:"unknown",thesis:"Need evidence",
    entryCondition:"Confirm",exitPlan:"Unset",invalidation:"No confirmation",riskCap:null,suggestedDebit:null,
    targetCredit:null,stopCredit:null,legs:[],evidence:[],missingEvidence:["Tape"]};
  process.env.PAPER_AUTOMATION_MODE="observe";process.env.PAPER_ENTRY_ENABLED="false";
  await storage.updateSettings({autoTradeEnabled:false});
  const id=crypto.randomUUID();
  const rows=await Promise.all([saveRecommendationDraft(draft,id,"fixture"),saveRecommendationDraft(draft,id,"fixture")]);
  assert.equal(rows[0]?.id,rows[1]?.id);
  const cookie=await login();
  assert.equal((await fetch(`${base}/api/copilot/drafts`)).status,401);
  const drafts=await (await fetch(`${base}/api/copilot/drafts`,{headers:{cookie}})).json();
  assert.equal(drafts.length,1);assert.equal(drafts[0].payload.riskCap,null);
  const path=`${base}/api/copilot/drafts/${drafts[0].id}`;
  const opts={method:"PATCH",headers:{"content-type":"application/json",cookie},body:JSON.stringify({version:1,payload:{...draft,title:"My edited thesis"}})};
  assert.equal((await fetch(path,{...opts,headers:{"content-type":"application/json"}})).status,401);
  assert.equal((await fetch(path,opts)).status,200);
  assert.equal((await fetch(path,opts)).status,409);
  const saved=(await sql.query("SELECT * FROM recommendation_drafts")).rows[0];
  assert.equal(saved.payload.title,"My edited thesis");assert.deepEqual(saved.original_payload,draft);
  for(const table of ["flies","spread_positions","spread_plans","spread_rules","journal_notes"])
    assert.equal((await sql.query(`SELECT count(*) FROM ${table}`)).rows[0].count,"0");
  assert.equal((await storage.getSettings()).autoTradeEnabled,false);
  assert.equal(process.env.PAPER_AUTOMATION_MODE,"observe");
});
test("chat sends only the draft tool and persists a validated model proposal",async()=>{
  const {runCopilotChat}=await import("../server/copilot");
  const {saveRecommendationDraft}=await import("../server/recommendation-drafts");
  const originalFetch=globalThis.fetch,oldKey=process.env.COPILOT_API_KEY;
  process.env.COPILOT_API_KEY="fixture-only-not-a-secret";
  const draft={title:"WAIT fixture",symbol:"SPY",strategy:"wait",direction:"unknown",thesis:"Evidence absent",
    entryCondition:"Verify first",exitPlan:"Unset",invalidation:"Missing evidence",riskCap:null,suggestedDebit:null,
    targetCredit:null,stopCredit:null,legs:[],evidence:[],missingEvidence:["Fresh quotes"]};
  try {
    globalThis.fetch=async(_url,init)=>{
      const body=JSON.parse(String(init?.body));
      assert.deepEqual(body.tools.map((t:any)=>t.name),["save_recommendation_draft"]);
      assert.match(body.system,/Unknown prices, strikes and dates must be null/);
      return new Response(JSON.stringify({model:"test",stop_reason:"tool_use",content:[{type:"tool_use",name:"save_recommendation_draft",input:draft}]}),{status:200});
    };
    const result=await runCopilotChat([{role:"user",content:"Plug in a recommendation, do not execute"}],{},
      (input,model)=>saveRecommendationDraft(input,crypto.randomUUID(),model));
    assert.ok(result.draft);assert.match(result.reply,/draft saved/i);
    assert.equal((await sql.query("SELECT count(*) FROM recommendation_drafts")).rows[0].count,"1");
    assert.equal((await storage.listFlies()).length,0);
  } finally {
    globalThis.fetch=originalFetch;
    if(oldKey===undefined)delete process.env.COPILOT_API_KEY;else process.env.COPILOT_API_KEY=oldKey;
  }
});
test("mode selector is authenticated, acknowledged, versioned and never arms entries",async()=>{
  const cookie=await login();
  const path=base+"/api/automation/mode";
  const put=(body:any,auth=true)=>fetch(path,{method:"PUT",headers:{"content-type":"application/json",...(auth?{cookie}:{})},body:JSON.stringify(body)});
  const body={mode:"observe",version:1,acknowledge:true};
  assert.equal((await put(body,false)).status,401);
  assert.notEqual((await put({...body,acknowledge:false})).status,200);
  assert.equal((await put({...body,mode:"live"})).status===200,false);
  assert.equal((await put(body)).status,200);
  assert.equal((await storage.getSettings()).autoTradeEnabled,false);
  assert.equal((await workerStatus()).mode,"observe");
  assert.equal((await put(body)).status,409);
  assert.equal((await sql.query("SELECT * FROM automation_mode_events")).rowCount,1);
  assert.equal((await put({mode:"paper",version:2,acknowledge:true})).status,409); // no heartbeat
  await sql.query("INSERT INTO paper_worker_runs(run_key,mode,outcome,started_at,finished_at) VALUES('mode-test','observe','ok',now(),now())");
  process.env.PAPER_ENTRY_ENABLED="false";
  assert.equal((await put({mode:"paper",version:2,acknowledge:true})).status,200);
  const status=await workerStatus();
  assert.equal(status.mode,"paper");assert.equal(status.entryLocked,true);assert.equal(status.entryArmed,false);
  await assert.rejects(storage.updateSettings({autoTradeEnabled:true}),/locked/);
});
test("persisted mode survives schema startup, blocks in-flight fills and honors emergency Observe override",async()=>{
  const {setAutomationMode,paperMode}=await import("../server/automation-control");
  const i=await input();
  await setAutomationMode("observe",1);
  await (await import("../server/storage")).ensureSchema();
  assert.equal(await paperMode(),"observe");
  await assert.rejects(commitEntry(i),/authorized/);
  await assert.rejects(storage.updateSettings({autoTradeEnabled:true}),/Observe/);
  await setAutomationMode("paper",2);
  assert.equal(await paperMode(),"paper");
  assert.equal((await storage.getSettings()).autoTradeEnabled,false);
  process.env.PAPER_AUTOMATION_FORCE_OBSERVE="true";
  assert.equal(await paperMode(),"observe");
  await assert.rejects(setAutomationMode("paper",3),/locked/);
  assert.equal((await storage.getSettings()).autoTradeEnabled,false);
});
test("Observe stops exits without closing positions; Paper resumes exits while entries remain disarmed",async()=>{
  const {setAutomationMode}=await import("../server/automation-control");
  const r=await commitEntry(await input());
  await setAutomationMode("observe",1);
  await assert.rejects(commitExit({flyId:r.flyId,mid:2,timestamp:now.toISOString(),source:"fixture",now:()=>now}),/authorized/);
  assert.equal((await storage.getFly(r.flyId)).status,"open");
  await setAutomationMode("paper",2);
  assert.equal((await storage.getSettings()).autoTradeEnabled,false);
  await commitExit({flyId:r.flyId,mid:2,timestamp:now.toISOString(),source:"fixture",now:()=>now});
  assert.equal((await storage.getFly(r.flyId)).status,"closed");
});
async function failJournal(){
  await sql.query(`CREATE OR REPLACE FUNCTION reject_paper_journal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected journal failure'; END $$;
    CREATE TRIGGER reject_journal BEFORE INSERT ON journal_notes FOR EACH ROW EXECUTE FUNCTION reject_paper_journal();`);
}
test("entry and journal commit exactly once under concurrent requests",async()=>{
  const i=await input();const results=await Promise.allSettled([commitEntry(i),commitEntry(i)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await storage.listFlies()).length,1);assert.equal((await storage.listJournalNotes()).length,1);
  assert.equal((await sql.query("SELECT * FROM paper_entry_claims")).rowCount,1);
});
test("entry journal failure rolls back position and claim; retry succeeds",async()=>{
  const i=await input();await failJournal();await assert.rejects(commitEntry(i),(err:any)=>/injected/.test(err.cause?.message));
  assert.equal((await storage.listFlies()).length,0);assert.equal((await sql.query("SELECT * FROM paper_entry_claims")).rowCount,0);
  await sql.query("DROP TRIGGER reject_journal ON journal_notes");await commitEntry(i);
});
test("closed or deleted same-week automated entry cannot be re-entered",async()=>{
  const i=await input();await commitEntry(i);
  await sql.query("UPDATE flies SET status='closed'");await assert.rejects(commitEntry(i),/entry already exists/);
  await sql.query("DELETE FROM flies");await assert.rejects(commitEntry(i),/claimed/);
});
test("entry disarm and changed settings during model review fail closed",async()=>{
  const i=await input();await storage.updateSettings({autoTradeEnabled:false});
  await assert.rejects(commitEntry(i),/Settings changed/);
  await storage.updateSettings({autoTradeEnabled:true,riskPerTradePercent:1});
  await assert.rejects(commitEntry(i),/Settings changed/);
});
test("changed wall, stale timestamp, out-of-window and observation mode reject commit",async()=>{
  const i=await input();
  await sql.query("UPDATE campaign_walls SET symbol='SPY'");await assert.rejects(commitEntry(i),/Campaign changed/);
  await sql.query("UPDATE campaign_walls SET symbol='QQQ'");
  await assert.rejects(commitEntry({...i,quoteTimestamp:"2026-09-21T13:55:00Z"}),/fresh/);
  await assert.rejects(commitEntry({...i,now:()=>new Date("2026-09-21T22:00:00Z")}),/in-window/);
  process.env.PAPER_AUTOMATION_MODE="observe";await assert.rejects(commitEntry(i),/authorized/);
});
test("exit and journal commit exactly once despite retries; entry disarmed does not block exit",async()=>{
  const {flyId}=await commitEntry(await input());await storage.updateSettings({autoTradeEnabled:false});
  const i={flyId,mid:2,timestamp:now.toISOString(),source:"test-fixture",now:()=>now};
  const results=await Promise.all([commitExit(i),commitExit(i)]);
  assert.deepEqual(results.map(r=>r.outcome).sort(),["already_closed","closed"]);
  assert.equal((await storage.getFly(flyId)).status,"closed");
  assert.equal((await storage.listJournalNotes()).length,2);
});
test("failed exit journal rolls back closure; changed policy is re-evaluated",async()=>{
  const {flyId}=await commitEntry(await input());
  const i={flyId,mid:2,timestamp:now.toISOString(),source:"fixture",now:()=>now};
  await failJournal();await assert.rejects(commitExit(i),(err:any)=>/injected/.test(err.cause?.message));assert.equal((await storage.getFly(flyId)).status,"open");
  await sql.query("DROP TRIGGER reject_journal ON journal_notes");
  await storage.updateSettings({takeProfitValue:3});await assert.rejects(commitExit(i),/trigger/);
  assert.equal((await storage.getFly(flyId)).status,"open");
});
test("exit switch and stale quotes block paper writes",async()=>{
  const {flyId}=await commitEntry(await input());
  const i={flyId,mid:2,timestamp:now.toISOString(),source:"fixture",now:()=>now};
  process.env.PAPER_EXIT_ENABLED="false";await assert.rejects(commitExit(i),/authorized/);
  delete process.env.PAPER_EXIT_ENABLED;
  await assert.rejects(commitExit({...i,timestamp:""}),/stale/);
});
test("worker observes a qualifying exit without writing and records heartbeat",async()=>{
  await commitEntry(await input());process.env.PAPER_AUTOMATION_MODE="observe";await storage.updateSettings({autoTradeEnabled:false});
  const deps={now,fetchChain:async()=>{throw Error("entry should not fetch");},buildSnapshot:async()=>({}),
    quote:async()=>({midDebit:2,timestamp:now.toISOString(),source:"test-fixture"})};
  const r=await runWorker(deps);assert.equal(r.outcome,"ok");assert.equal(r.exits[0].outcome,"would_close");
  assert.equal((await storage.listFlies())[0].status,"open");
  assert.equal((await workerStatus()).healthy,true);
  assert.equal((await runWorker(deps)).outcome,"already_ran");
});
test("concurrent workers use a database lease and perform one exit",async()=>{
  await commitEntry(await input());await storage.updateSettings({autoTradeEnabled:false});
  const deps={now,fetchChain:async()=>{throw Error("disabled");},buildSnapshot:async()=>({}),
    quote:async()=>({midDebit:2,timestamp:now.toISOString(),source:"test-fixture"})};
  const results=await Promise.all([runWorker(deps),runWorker(deps)]);
  assert.equal(results.filter(r=>r.outcome==="ok").length,1);
  assert.equal((await storage.listFlies())[0].status,"closed");
  assert.equal((await storage.listJournalNotes()).length,2);
});
test("worker records stale quote alert and expired settlement requires review",async()=>{
  await commitEntry(await input());await storage.updateSettings({autoTradeEnabled:false});
  const deps={now,fetchChain:async()=>{throw Error("disabled");},buildSnapshot:async()=>({}),
    quote:async()=>({midDebit:2,timestamp:"",source:"test-fixture"})};
  const r=await runWorker(deps);assert.equal(r.outcome,"degraded");assert.match(r.alerts[0],/stale/);
  assert.equal((await workerStatus()).healthy,false);
  await sql.query("DELETE FROM paper_worker_runs");await sql.query("UPDATE flies SET expiration='2026-09-18'");
  assert.match((await runWorker(deps)).alerts[0],/expired/);
});
test("worker after hours never prices or changes positions",async()=>{
  await commitEntry(await input());
  const unexpected=async()=>{throw Error("should not call");};
  const r=await runWorker({now:new Date("2026-09-21T22:00:00Z"),fetchChain:unexpected,buildSnapshot:unexpected,quote:unexpected});
  assert.equal(r.outcome,"ok");assert.equal((await storage.listFlies())[0].status,"open");
});
test("disabled entry and Thursday guard run before external requests",async()=>{
  const deps={now,fetchChain:async()=>{throw Error("unexpected");},buildSnapshot:async()=>({})};
  await storage.updateSettings({autoTradeEnabled:false});assert.equal((await runAuto(deps)).outcome,"disabled");
  await storage.updateSettings({autoTradeEnabled:true});
  assert.match((await runAuto({...deps,now:new Date("2026-09-24T14:00:00Z")})).detail,/Thursday/);
});
test("gate rejects empty, incomplete schemas and prose-wrapped JSON",()=>{
  for(const text of ["",'{"approved":true,"rationale":"ok"}','prefix {"approved":true,"confidence":"high","rationale":"ok","concerns":[]}']) {
    assert.equal(parseVerdict(text,"fixture").approved,false);
  }
  assert.equal(parseVerdict('{"approved":true,"confidence":"high","rationale":"ok","concerns":[]}',"fixture").approved,true);
});
test("unauthenticated reads, writes and entry preview are denied",async()=>{
  for(const [method,path] of [["GET","/api/settings"],["PUT","/api/settings"],["GET","/api/auto-trade/preview"],["POST","/api/auto-trade/run"],["PATCH","/api/flies/1"]]) {
    assert.equal((await fetch(base+path,{method})).status,401);
  }
});
test("operator session, same-origin protection and fail-closed unset password",async()=>{
  const cookie=await login();
  assert.equal((await fetch(base+"/api/settings",{headers:{cookie}})).status,200);
  assert.equal((await fetch(base+"/api/settings",{method:"PUT",headers:{cookie,origin:"https://attacker.invalid","content-type":"application/json"},body:"{}"})).status,403);
  delete process.env.WINGWALL_OPERATOR_PASSWORD;
  assert.equal((await fetch(base+"/api/settings",{headers:{cookie}})).status,401);
  assert.equal((await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:'{"password":"anything"}'})).status,503);
});
test("login attempts are rate limited across requests",async()=>{
  for(let i=0;i<10;i++) assert.equal((await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:'{"password":"wrong"}'})).status,401);
  assert.equal((await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:'{"password":"wrong"}'})).status,429);
});
test("arming is rejected in observation mode even with authenticated operator",async()=>{
  process.env.PAPER_AUTOMATION_MODE="observe";const cookie=await login();
  assert.equal((await fetch(base+"/api/settings",{method:"PUT",headers:{cookie,"content-type":"application/json"},body:'{"autoTradeEnabled":true}'})).status,409);
});
test("missing, negative-gamma and expired reviews block automatic entries without ledger writes",async()=>{
  const i=await input();
  await sql.query("DELETE FROM strategy_reviews");await assert.rejects(commitEntry(i),/mentor checklist/);
  await sql.query("INSERT INTO strategy_reviews(symbol,strategy,payload,version,created_at) VALUES('QQQ','butterfly',$1,$2,$3)",
    [JSON.stringify({symbol:"QQQ",strategy:"butterfly",gamma:"negative",direction:"bearish",flipChop:"no",strongConfirmation:"yes",checks:Object.fromEntries(CHECKLISTS.butterfly.map(c=>[c.id,"go"])),evidence:"Negative gamma fixture"}),CHECKLIST_VERSION,now]);
  await assert.rejects(commitEntry(i),/mentor checklist/);
  await sql.query(`UPDATE strategy_reviews SET payload=jsonb_set(payload,'{gamma}','"positive"'),created_at=$1`,[new Date(now.getTime()-31*60_000)]);
  await assert.rejects(commitEntry(i),/mentor checklist/);
  assert.equal((await storage.listFlies()).length,0);
});
test("new NO-GO supersedes earlier GO, and review route rejects unrecognized status",async()=>{
  const cookie=await login();
  const payload={symbol:"QQQ",strategy:"butterfly",gamma:"negative",direction:"bearish",flipChop:"no",strongConfirmation:"yes",
    checks:Object.fromEntries(CHECKLISTS.butterfly.map(c=>[c.id,"go"])),evidence:"Current observation: negative gamma"};
  const r=await fetch(`${base}/api/strategy/reviews`,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify(payload)});
  assert.equal(r.status,201);assert.equal((await r.json()).assessment.status,"no_go");
  await assert.rejects(commitEntry(await input()),/mentor checklist/);
  const invalid=await fetch(`${base}/api/strategy/reviews`,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({...payload,gamma:"assumed"})});
  assert.notEqual(invalid.status,201);
});
test("manual open cannot bypass checklist; historical closed record and exit remain possible",async()=>{
  await sql.query("DELETE FROM strategy_reviews");
  await assert.rejects(storage.createFly(position),/mentor checklist/);
  const old=await storage.createFly({...position,status:"closed",exitDebit:1,exitDate:"2026-09-21"});
  assert.equal(old.status,"closed");
});
test("layer plans persist with no positions, claims or journals and reject excess risk",async()=>{
  const cookie=await login();
  const plan={symbol:"QQQ",direction:"bullish",riskCap:100,maxLayers:2,thesis:"Hold above VWAP; invalidate on sustained reversal",
    layers:[{optionType:"call",expiration:"2026-09-24",longStrike:100,shortStrike:105,contracts:1,debit:0.5,targetCredit:1.5,stopCredit:0.1,addTrigger:"Only after confirmed retest holds"}]};
  const request=(p:any)=>fetch(`${base}/api/strategy/plans`,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify(p)});
  const r=await request(plan);assert.equal(r.status,201);
  const body=await r.json();assert.equal(body.payload.status,"plan_only");assert.equal(body.payload.calculation.totalMaxLoss,50);
  assert.equal((await storage.listFlies()).length,0);assert.equal((await storage.listJournalNotes()).length,0);
  assert.equal((await sql.query("SELECT * FROM paper_entry_claims")).rowCount,0);
  assert.equal((await request({...plan,riskCap:25})).status,409);
  assert.equal((await sql.query("SELECT * FROM spread_plans")).rowCount,1);
});
test("strategy endpoints require operator login",async()=>{
  for(const path of ["/api/strategy","/api/strategy/reviews","/api/strategy/plans"]) {
    const r=await fetch(base+path,{method:path==="/api/strategy"?"GET":"POST",headers:{"content-type":"application/json"},...(path==="/api/strategy"?{}:{body:"{}"})});
    assert.equal(r.status,401);
  }
});
test("no-go review stops proposal before external feeds or model; existing exits are not gated",async()=>{
  const {flyId}=await commitEntry(await input());
  await sql.query("DELETE FROM strategy_reviews");
  const result=await commitExit({flyId,mid:2,timestamp:now.toISOString(),source:"fixture",now:()=>now});
  assert.equal(result.outcome,"closed");
  const deps={now,fetchChain:async()=>{throw Error("must not fetch");},buildSnapshot:async()=>{throw Error("must not snapshot");},askModel:async()=>{throw Error("must not call model");}};
  const response=await runAuto(deps,{dryRun:true,ignoreToggle:true});
  assert.equal(response.outcome,"no_proposal");assert.match(response.detail,/mentor checklist/);
});
test("current GO permits manual paper entry but open exposure edits cannot bypass it",async()=>{
  await sql.query("UPDATE strategy_reviews SET created_at=now()");
  const fly=await storage.createFly(position);
  assert.match(fly.notes,/Mentor checklist review/);
  await assert.rejects(storage.updateFly(fly.id,{contracts:2}),/immutable/);
  const note=await storage.updateFly(fly.id,{notes:"updated observation"});
  assert.equal(note.notes,"updated observation");
});

async function spreadFixture(layers=1){
  await sql.query("UPDATE settings SET account_balance=5000");
  const layer={optionType:"call",expiration:"2026-09-24",longStrike:100,shortStrike:105,contracts:1,debit:1.8,targetCredit:4.5,stopCredit:.2,addTrigger:"Hold above the confirmed directional level"};
  const plan={symbol:"QQQ",direction:"bullish",riskCap:500,maxLayers:layers,thesis:"Directional continuation; invalidate on reversal",layers:Array.from({length:layers},()=>({...layer}))};
  const id=(await sql.query("INSERT INTO spread_plans(payload) VALUES($1) RETURNING id",[plan])).rows[0].id;
  const rules={enabled:true,triggers:plan.layers.map(()=>({comparison:"above",spot:100})),feePerContractLeg:.65,slippagePerSpread:.02};
  await sql.query("INSERT INTO spread_rules(plan_id,payload) VALUES($1,$2)",[id,rules]);
  const review={symbol:"QQQ",strategy:"debit_spread",gamma:"positive",direction:"bullish",flipChop:"no",strongConfirmation:"yes",
    checks:Object.fromEntries(CHECKLISTS.debit_spread.map(c=>[c.id,"go"])),evidence:"Fixture directional evidence only"};
  await sql.query("INSERT INTO strategy_reviews(symbol,strategy,payload,version,created_at) VALUES('QQQ','debit_spread',$1,$2,$3)",[review,CHECKLIST_VERSION,now]);
  return {id,rules,plan};
}
const spreadChain=(at=now,longBid=2)=>({symbol:"QQQ",spot:101,timestamp:at.toISOString(),options:[
  {strike:100,expiration:"2026-09-24",type:"call",bid:longBid,ask:longBid+.1},
  {strike:105,expiration:"2026-09-24",type:"call",bid:1,ask:1.1}]});
async function spreadRun(chain:any=spreadChain(),at=now){
  const {runSpreadLearning}=await import("../server/spread-learning");
  return runSpreadLearning(async()=>chain,at);
}
test("spread worker commits once under concurrent evaluations with evidence and costs",async()=>{
  await spreadFixture();await Promise.all([spreadRun(),spreadRun()]);
  const p=(await sql.query("SELECT * FROM spread_positions")).rows;
  assert.equal(p.length,1);assert.ok(Math.abs(p[0].entry_debit-1.12)<1e-8);assert.equal(p[0].entry_fees,1.3);
  assert.equal(p[0].entry_evidence.review.strategy,"debit_spread");
});
test("observe mode records a decision but cannot create a paper fill",async()=>{
  await spreadFixture();process.env.PAPER_AUTOMATION_MODE="observe";await spreadRun();
  assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,0);
  assert.equal((await sql.query("SELECT * FROM spread_decisions WHERE action='would_enter'")).rowCount,1);
});
test("spread ledger rechecks persisted mode after fetching quotes and resumes exits without arming entries",async()=>{
  const {setAutomationMode}=await import("../server/automation-control");
  const {runSpreadLearning}=await import("../server/spread-learning");
  await spreadFixture();
  await runSpreadLearning(async()=>{await setAutomationMode("observe",1);return spreadChain();},now);
  assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,0);
  await setAutomationMode("paper",2);
  await storage.updateSettings({autoTradeEnabled:true});
  await spreadRun();
  assert.equal((await sql.query("SELECT * FROM spread_positions WHERE status='open'")).rowCount,1);
  await setAutomationMode("observe",3);
  const later=new Date("2026-09-21T14:01:00Z");
  await spreadRun(spreadChain(later,5.7),later);
  assert.equal((await sql.query("SELECT * FROM spread_positions WHERE status='open'")).rowCount,1);
  await setAutomationMode("paper",4);
  await spreadRun(spreadChain(later,5.7),later);
  assert.equal((await sql.query("SELECT * FROM spread_positions WHERE status='closed'")).rowCount,1);
  assert.equal((await storage.getSettings()).autoTradeEnabled,false);
});
test("stale quotes, wrong symbols and missing leg quotes block spread execution",async()=>{
  await spreadFixture();
  for(const chain of [{...spreadChain(),timestamp:"2026-09-21T13:00:00Z"},{...spreadChain(),symbol:"SPY"},{...spreadChain(),options:[]}]){
    await spreadRun(chain);assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,0);
  }
});
test("no entry with disabled master, failed review or exceeded account budget",async()=>{
  await spreadFixture();
  await sql.query("UPDATE settings SET auto_trade_enabled=false");await spreadRun();
  assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,0);
  await sql.query("UPDATE settings SET auto_trade_enabled=true,account_balance=100");await spreadRun();
  assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,0);
  await sql.query("UPDATE settings SET account_balance=5000;DELETE FROM strategy_reviews WHERE strategy='debit_spread'");await spreadRun();
  assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,0);
});
test("spread take-profit exits despite disarmed entries and missing reviews; P&L net of both fees",async()=>{
  const {id}=await spreadFixture();await spreadRun();
  await sql.query("UPDATE settings SET auto_trade_enabled=false;DELETE FROM strategy_reviews");
  await sql.query("UPDATE spread_rules SET payload=jsonb_set(payload,'{enabled}','false') WHERE plan_id=$1",[id]);
  const later=new Date("2026-09-21T14:01:00Z");await spreadRun(spreadChain(later,5.7),later);
  const p=(await sql.query("SELECT * FROM spread_positions")).rows[0];
  assert.equal(p.status,"closed");assert.equal(p.exit_reason,"take-profit");assert.ok(Math.abs(p.realized_pnl-343.4)<1e-6);
  await spreadRun(spreadChain(later,5.7),later);
  assert.equal((await sql.query("SELECT * FROM spread_decisions WHERE action='exit'")).rowCount,1);
});
test("spread stops are automatic and stale exit quotes cannot invent a close",async()=>{
  await spreadFixture();await spreadRun();
  const later=new Date("2026-09-21T14:05:00Z");
  await spreadRun(spreadChain(now,1.2),later);
  assert.equal((await sql.query("SELECT status FROM spread_positions")).rows[0].status,"open");
  await spreadRun(spreadChain(later,1.2),later);
  assert.equal((await sql.query("SELECT exit_reason FROM spread_positions")).rows[0].exit_reason,"stop-loss");
});
test("layers wait ten minutes, reject averaging down, then allow a profitable add",async()=>{
  await spreadFixture(2);await spreadRun();
  const early=new Date("2026-09-21T14:05:00Z");await spreadRun(spreadChain(early,2.5),early);
  assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,1);
  const later=new Date("2026-09-21T14:11:00Z");await spreadRun(spreadChain(later),later);
  assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,1);
  await spreadRun(spreadChain(later,2.5),later);
  assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,2);
});
test("spread expiry curfew closes while an already expired contract requires settlement",async()=>{
  await spreadFixture();await spreadRun();
  const curfew=new Date("2026-09-24T19:46:00Z");await spreadRun(spreadChain(curfew),curfew);
  assert.equal((await sql.query("SELECT exit_reason FROM spread_positions")).rows[0].exit_reason,"expiry-curfew");
  await sql.query("UPDATE spread_positions SET status='open',exit_reason=NULL");
  const expired=new Date("2026-09-25T14:00:00Z");await spreadRun(spreadChain(expired),expired);
  assert.equal((await sql.query("SELECT status FROM spread_positions")).rows[0].status,"open");
  assert.equal((await sql.query("SELECT * FROM spread_decisions WHERE action='settlement_required'")).rowCount,1);
});
test("spread entries require fresh evidence and no layers add after a close",async()=>{
  await spreadFixture(2);
  await sql.query("UPDATE strategy_reviews SET created_at=created_at-interval '1 hour' WHERE strategy='debit_spread'");
  await spreadRun();assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,0);
  await sql.query("UPDATE strategy_reviews SET created_at=$1",[now]);
  await spreadRun();
  const later=new Date("2026-09-21T14:11:00Z");await spreadRun(spreadChain(later,1.2),later);
  await spreadRun(spreadChain(later,2.5),later);
  assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,1);
  assert.equal((await sql.query("SELECT status FROM spread_positions")).rows[0].status,"closed");
});
test("manual and automatic butterfly entry cannot overlap open spread campaign",async()=>{
  await spreadFixture();await spreadRun();
  await sql.query("UPDATE strategy_reviews SET created_at=now()");
  await assert.rejects(storage.createFly(position),/spreads are open/);
  await assert.rejects(commitEntry(await input()),/spreads are already open/);
});
test("learning endpoints authenticate and retain reflections for later chat context",async()=>{
  assert.equal((await fetch(base+"/api/learning")).status,401);
  await spreadFixture();await spreadRun();const cookie=await login();
  const p=(await sql.query("SELECT id FROM spread_positions")).rows[0];
  const r=await fetch(base+"/api/learning/reflections",{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({positionId:p.id,text:"I followed the trigger; next time compare the evidence before the price move."})});
  assert.equal(r.status,201);
  const snapshot=await (await fetch(base+"/api/learning",{headers:{cookie}})).json();
  assert.equal(snapshot.reflections.length,1);assert.equal(snapshot.summary.open,1);
  assert.equal(snapshot.positions[0].entry_evidence.policy,"paper-spread-v1");
});
test("post-entry policy edits are rejected but entry disarming is allowed",async()=>{
  const {id,rules}=await spreadFixture();await spreadRun();const cookie=await login();
  const post=(body:any)=>fetch(`${base}/api/strategy/plans/${id}/automation`,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await post({...rules,enabled:false,feePerContractLeg:0})).status,409);
  assert.equal((await post({...rules,enabled:false})).status,200);
});
test("multiple layer exits in one minute each retain their own decision evidence",async()=>{
  await spreadFixture(2);await spreadRun();
  const later=new Date("2026-09-21T14:11:00Z");await spreadRun(spreadChain(later,2.5),later);
  const exitAt=new Date("2026-09-21T14:12:00Z");await spreadRun(spreadChain(exitAt,5.7),exitAt);
  assert.equal((await sql.query("SELECT * FROM spread_positions WHERE status='closed'")).rowCount,2);
  assert.equal((await sql.query("SELECT * FROM spread_decisions WHERE action='exit'")).rowCount,2);
});
test("deployment entry lock persists disarm, prevents rearming and blocks both entry ledgers",async()=>{
  const entry=await input();await spreadFixture();
  process.env.PAPER_ENTRY_ENABLED="false";
  try{
    await assert.rejects(commitEntry(entry),/not.*authorized|no longer authorized/);
    await spreadRun();assert.equal((await sql.query("SELECT * FROM spread_positions")).rowCount,0);
    const {ensureSchema}=await import("../server/storage");await ensureSchema();
    assert.equal((await storage.getSettings()).autoTradeEnabled,false);
    await assert.rejects(storage.updateSettings({autoTradeEnabled:true}),/locked off/);
    assert.equal((await workerStatus()).entryLocked,true);
  }finally{delete process.env.PAPER_ENTRY_ENABLED;}
});
