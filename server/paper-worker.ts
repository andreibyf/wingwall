import { db, storage } from "./storage";
import { sql } from "drizzle-orm";
import { runAutoTrade, type AutoTradeDeps } from "./auto-trade";
import { commitPaperExit } from "./paper-ledger";
import { eastern, entryWindow, exitReason, freshQuote, marketOpen } from "./automation-policy";
import {paperMode,automationControl} from "./automation-control";
import { operatorConfigured } from "./operator-auth";
import {runSpreadLearning} from "./spread-learning";

export type QuoteFn = (symbol:string,type:"call"|"put",expiry:string,lower:number,body:number,upper:number,contracts:number)=>Promise<any>;
export async function workerStatus() {
  const rows = await db.execute(sql`SELECT run_key,started_at,finished_at,mode,outcome,detail FROM paper_worker_runs ORDER BY started_at DESC LIMIT 10`);
  const latest=rows.rows[0];
  const heartbeatFresh=Boolean(latest && Date.now()-new Date(latest.started_at as string).getTime()<180_000);
  const lastCompleted=rows.rows.find(r=>r.finished_at);
  const healthy=heartbeatFresh && Boolean(lastCompleted && Date.now()-new Date(lastCompleted.finished_at as string).getTime()<180_000) && lastCompleted?.outcome==="ok";
  const settings=await storage.getSettings();
  const control=await automationControl();
  const window=entryWindow();
  const blockers=[
    ...(control.mode!=="paper"?["Observe mode: no automatic entries or exits"]:[]),
    ...(process.env.PAPER_ENTRY_ENABLED==="false"?["Deployment entry lock is on; UI cannot override it"]:[]),
    ...(!settings?.autoTradeEnabled?["Master Auto entry switch is off"]:[]),
    ...(!healthy?["Worker heartbeat or completion is unhealthy"]:[]),
    ...(!operatorConfigured()?["Operator authentication is not configured"]:[]),
    ...(!window.allowed?[window.reason]:[]),
  ];
  return {paperOnly:true,mode:control.mode,modeControl:control,blockers,
    quoteReadiness:"Not certified by heartbeat. Fresh quotes, current checklist evidence and risk limits are checked for each decision.",
    entryArmed:settings?.autoTradeEnabled===true,
    entryLocked:process.env.PAPER_ENTRY_ENABLED==="false",
    exitsEnabled:process.env.PAPER_EXIT_ENABLED!=="false",heartbeatFresh,healthy,
    operatorConfigured:operatorConfigured(),quoteMaxAgeSeconds:120,
    nextEntryWindow:"Monday–Wednesday, 09:45–10:30 America/New_York; exchange holidays excluded",
    runs:rows.rows};
}
export async function runPaperWorker(deps:AutoTradeDeps & {quote:QuoteFn}) {
  const client=await db.$client.connect();
  let locked=false;
  const now=deps.now??new Date(), key=`paper:${Math.floor(now.getTime()/60_000)}`;
  try {
    locked=Boolean((await client.query("SELECT pg_try_advisory_lock(714001) AS locked")).rows[0].locked);
    if(!locked) return {outcome:"busy"};
    await client.query(`UPDATE paper_worker_runs SET outcome='abandoned',finished_at=now(),
      detail='{"alert":"Previous worker stopped before completion; writes must be reconciled from ledger"}'
      WHERE finished_at IS NULL AND started_at < now()-interval '3 minutes'`);
    const inserted=await client.query(`INSERT INTO paper_worker_runs(run_key,mode,outcome)
      VALUES($1,$2,'running') ON CONFLICT DO NOTHING RETURNING run_key`,[key,await paperMode()]);
    if(!inserted.rowCount) return {outcome:"already_ran"};
    const detail:any={entry:null,exits:[],alerts:[]};
    try {
      if(!marketOpen(now)) {
        detail.session="Exchange closed; no simulated executions";
      } else {
        const settings=await storage.getSettings();
        if(!settings) throw Error("Missing settings");
        for(const fly of (await storage.listFlies()).filter(f=>f.status==="open")) {
          if(Date.now()-now.getTime()>90_000 && !deps.now) {detail.alerts.push("Worker deadline exceeded");break;}
          if(fly.expiration<eastern(now).date) {detail.alerts.push(`Fly ${fly.id}: expired, manual settlement required`);continue;}
          if(!["QQQ","SPY"].includes(fly.symbol)) {detail.alerts.push(`Fly ${fly.id}: unsupported automatic pricing`);continue;}
          try {
            const quote=await deps.quote(fly.symbol,fly.optionType as "call"|"put",fly.expiration,fly.lowerStrike,fly.middleStrike,fly.upperStrike,fly.contracts);
            if(!freshQuote(quote.timestamp,deps.now??new Date()) || !Number.isFinite(quote.midDebit) || quote.midDebit<0) {
              detail.alerts.push(`Fly ${fly.id}: unavailable/stale quote; no close executed`);continue;
            }
            const reason=exitReason(fly,quote.midDebit,settings,deps.now??new Date());
            if(!reason) {detail.exits.push({flyId:fly.id,outcome:"no_trigger"});continue;}
            if(await paperMode()==="observe" || process.env.PAPER_EXIT_ENABLED==="false") {
              detail.exits.push({flyId:fly.id,outcome:"would_close",reason,quoteTimestamp:quote.timestamp});
            } else {
              if(!operatorConfigured()) throw Error("Operator authentication not configured");
              detail.exits.push(await commitPaperExit({flyId:fly.id,mid:quote.midDebit,timestamp:quote.timestamp,source:quote.source,
                ...(deps.now?{now:()=>deps.now!}:{})}));
            }
          } catch(err) {detail.alerts.push(`Fly ${fly.id}: ${(err as Error).message}`);}
        }
        detail.spreads=await runSpreadLearning(deps.fetchChain,deps.now);
        for(const d of detail.spreads.decisions??[])if(["blocked","exit_blocked","settlement_required"].includes(d.action))detail.alerts.push(`Spread plan ${d.planId}: ${d.reason}`);
        // Interval-based cooldown, not an exact-minute gate. Delayed wakes still work.
        const recent=await client.query(`SELECT 1 FROM paper_worker_runs WHERE finished_at IS NOT NULL
          AND detail->'entry' IS NOT NULL AND detail->'entry'<>'null'::jsonb
          AND started_at > now()-interval '5 minutes' LIMIT 1`);
        if(!recent.rowCount && entryWindow(now).allowed) {
          const observing=await paperMode()==="observe";
          detail.entry=await runAutoTrade(deps,{dryRun:observing,ignoreToggle:observing});
          if(detail.entry.outcome==="error" || detail.entry.verdict?.parseError || /quote|timestamp/i.test(detail.entry.detail??"")) {
            detail.alerts.push(`Entry blocked: ${detail.entry.detail}`);
          }
        } else detail.entryWindow=entryWindow(now).reason;
      }
      const outcome=detail.alerts.length?"degraded":"ok";
      await client.query("UPDATE paper_worker_runs SET finished_at=now(),outcome=$2,detail=$3 WHERE run_key=$1",[key,outcome,JSON.stringify(detail)]);
      if(detail.alerts.length) console.error("paper_worker_alert",{runKey:key,alerts:detail.alerts});
      await client.query("DELETE FROM operator_login_attempts WHERE created_at<now()-interval '1 day'");
      await client.query("DELETE FROM paper_worker_runs WHERE started_at<now()-interval '30 days'");
      return {outcome,...detail};
    } catch(err) {
      await client.query("UPDATE paper_worker_runs SET finished_at=now(),outcome='error',detail=$2 WHERE run_key=$1",
        [key,JSON.stringify({alert:(err as Error).message})]);
      console.error("paper_worker_error",{runKey:key,message:(err as Error).message});
      return {outcome:"error"};
    }
  } finally {
    try {
      if(locked) await client.query("SELECT pg_advisory_unlock(714001)");
    } finally {
      client.release();
    }
  }
}
export function startPaperWorkers(deps:AutoTradeDeps & {quote:QuoteFn}) {
  let busy=false;
  const tick=async()=>{
    if(busy)return;
    busy=true;
    try {await runPaperWorker(deps);}catch(err){console.error("paper_worker_unavailable",(err as Error).message);}
    finally{busy=false;}
  };
  void tick();
  const timer=setInterval(()=>void tick(),60_000);
  timer.unref();
  return ()=>clearInterval(timer);
}
