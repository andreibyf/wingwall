import {sql} from "drizzle-orm";
import type {Express} from "express";
import {db} from "./storage";
import {latestStrategyReview} from "./strategy-store";
import {currentReview} from "../shared/strategy-policy";
import {spreadRuleSchema,spreadQuote,learningSummary} from "../shared/paper-learning";
import {eastern,session,entryWindow,marketOpen,freshQuote,paperMode} from "./automation-policy";
import {operatorConfigured} from "./operator-auth";
import {z} from "zod";
const fail=(message:string)=>Object.assign(Error(message),{status:409});
const lock=sql`LOCK TABLE settings,flies,spread_plans,spread_rules,spread_positions,strategy_reviews IN SHARE ROW EXCLUSIVE MODE`;
export async function learningSnapshot(){
  const positions=(await db.execute(sql`SELECT * FROM spread_positions ORDER BY id DESC`)).rows;
  return {positions,summary:learningSummary(positions),
    rules:(await db.execute(sql`SELECT * FROM spread_rules ORDER BY plan_id`)).rows,
    decisions:(await db.execute(sql`SELECT * FROM spread_decisions ORDER BY id DESC LIMIT 100`)).rows,
    reflections:(await db.execute(sql`SELECT * FROM trade_reflections ORDER BY id DESC LIMIT 50`)).rows,
    mode:paperMode(),policy:"paper-spread-v1",
    instructions:["State thesis and evidence, then say what would invalidate it.",
      "Compare butterfly, directional spread and waiting; explain why alternatives fail.",
      "Before entry: confirm current review, both bid/ask legs, total debit risk and costs.",
      "After exit: separate process quality from profit, compare intended versus actual actions, and write one testable lesson.",
      "Lessons are retrieved context, not model retraining. No automatic policy changes or promises of improvement."]};
}
export function registerLearningRoutes(app:Express){
  app.get("/api/learning",async(_req,res,next)=>{try{res.json(await learningSnapshot());}catch(e){next(e);}});
  app.post("/api/learning/reflections",async(req,res,next)=>{try{
    const body=z.object({positionId:z.number().int().positive(),text:z.string().trim().min(10).max(4000)}).strict().parse(req.body);
    const row=await db.execute(sql`INSERT INTO trade_reflections(position_id,text)
      SELECT id,${body.text} FROM spread_positions WHERE id=${body.positionId} RETURNING *`);
    if(!row.rows.length)throw fail("Position not found");
    res.status(201).json(row.rows[0]);
  }catch(e){next(e);}});
  app.post("/api/strategy/plans/:id/automation",async(req,res,next)=>{try{
    const id=z.coerce.number().int().positive().parse(req.params.id),rules=spreadRuleSchema.parse(req.body);
    await db.transaction(async tx=>{
      await tx.execute(lock);
      const p=(await tx.execute(sql`SELECT payload FROM spread_plans WHERE id=${id}`)).rows[0]?.payload as any;
      if(!p)throw fail("Plan not found");
      const used=await tx.execute(sql`SELECT 1 FROM spread_positions WHERE plan_id=${id} LIMIT 1`);
      const old=(await tx.execute(sql`SELECT payload FROM spread_rules WHERE plan_id=${id}`)).rows[0]?.payload as any;
      if(used.rows.length && (!old||JSON.stringify({...spreadRuleSchema.parse(old),enabled:false})!==JSON.stringify({...rules,enabled:false})))throw fail("Once entered, only enable/disable may change; exit/cost policy is frozen");
      if(rules.enabled){
        if(p.layers.length!==rules.triggers.length)throw fail("Declare one numeric trigger for every layer");
        const review=await latestStrategyReview(p.symbol,"debit_spread",tx);
        if(!currentReview(review)||review.assessment.status!=="go"||review.direction!==p.direction)throw fail("Current matching GO spread review required");
        const today=eastern().date;
        if(p.layers.some((l:any)=>l.expiration<=today||!session(l.expiration).open))throw fail("Use a future supported trading-day expiration");
      }
      await tx.execute(sql`INSERT INTO spread_rules(plan_id,payload) VALUES(${id},${JSON.stringify(rules)}::jsonb)
        ON CONFLICT(plan_id) DO UPDATE SET payload=excluded.payload`);
      await tx.execute(sql`INSERT INTO spread_decisions(plan_id,action,detail) VALUES(${id},'configuration',${JSON.stringify({rules,policy:"paper-spread-v1"})}::jsonb)`);
    });
    res.json({saved:true,mode:paperMode(),message:"Paper rules saved. Observe mode does not execute; master entry switch and fresh evidence still required. Disabling entries never disables exits."});
  }catch(e){next(e);}});
}
// Called by the existing once-per-minute, advisory-locked scheduler. No broker API.
export async function runSpreadLearning(fetchChain:(s:string)=>Promise<any>,fixedNow?:Date){
  const now=()=>fixedNow??new Date();
  if(!marketOpen(now()))return {outcome:"market_closed"};
  const plans=(await db.execute(sql`SELECT p.id,p.payload,r.payload AS rules FROM spread_plans p JOIN spread_rules r ON r.plan_id=p.id
    WHERE (r.payload->>'enabled')::boolean OR EXISTS(SELECT 1 FROM spread_positions s WHERE s.plan_id=p.id AND s.status='open') ORDER BY p.id`)).rows;
  const chains=new Map<string,any>();
  const outcomes:any[]=[];
  for(const row of plans){
    let chain:any;
    const symbol=(row.payload as any).symbol;
    try{
      if(!chains.has(symbol))chains.set(symbol,await fetchChain(symbol));
      chain=chains.get(symbol);
    }catch(e){chain={error:(e as Error).message};chains.set(symbol,chain);}
    await db.transaction(async tx=>{
      await tx.execute(lock);
      const plan=(await tx.execute(sql`SELECT payload FROM spread_plans WHERE id=${row.id}`)).rows[0].payload as any;
      const rules=(await tx.execute(sql`SELECT payload FROM spread_rules WHERE plan_id=${row.id}`)).rows[0].payload as any;
      const record=async(action:string,detail:any)=>{
        outcomes.push({planId:row.id,action,...detail});
        // One durable decision per plan per minute; repeated scheduler wakes are idempotent.
        const key=`${row.id}:${Math.floor(now().getTime()/60000)}:${action}:${detail.positionId??detail.layer??""}:${detail.reason??""}`;
        await tx.execute(sql`INSERT INTO spread_decisions(plan_id,action,detail,decision_key) VALUES(${row.id},${action},${JSON.stringify({...detail,policy:"paper-spread-v1",timestamp:now().toISOString()})}::jsonb,${key}) ON CONFLICT(decision_key) DO NOTHING`);
      };
      if(chain.symbol!==plan.symbol||!marketOpen(now())||!freshQuote(chain?.timestamp,now())){await record("blocked",{reason:"Market closed or quote missing/stale/wrong symbol; no simulated fills",providerError:chain.error});return;}
      const positions=(await tx.execute(sql`SELECT * FROM spread_positions WHERE plan_id=${row.id} ORDER BY layer_index`)).rows as any[];
      const settings=(await tx.execute(sql`SELECT * FROM settings WHERE id=1`)).rows[0] as any;
      const executable=paperMode()==="paper"&&operatorConfigured();
      for(const position of positions.filter(p=>p.status==="open")){
        const l=plan.layers[position.layer_index],et=eastern(now());
        if(l.expiration<et.date){await record("settlement_required",{positionId:position.id,reason:"Expired; no invented settlement"});continue;}
        try{
          const q=spreadQuote(chain,l),credit=Math.max(0,q.exit-rules.slippagePerSpread);
          const reason=l.expiration===et.date&&et.minute>=session(et.date).close-15?"expiry-curfew":
            credit>=l.targetCredit?"take-profit":credit<=l.stopCredit?"stop-loss":null;
          await tx.execute(sql`UPDATE spread_positions SET mark_credit=${credit},mark_at=${chain.timestamp} WHERE id=${position.id}`);
          if(!reason)continue;
          if(!executable||process.env.PAPER_EXIT_ENABLED==="false"){await record("would_exit",{positionId:position.id,reason,credit});continue;}
          const pnl=(credit-Number(position.entry_debit))*100*l.contracts-Number(position.entry_fees)-2*l.contracts*rules.feePerContractLeg;
          await tx.execute(sql`UPDATE spread_positions SET status='closed',exit_credit=${credit},realized_pnl=${pnl},closed_at=${now().toISOString()},exit_reason=${reason} WHERE id=${position.id} AND status='open'`);
          position.status="closed";
          await record("exit",{positionId:position.id,reason,credit,netPnl:pnl,quoteTimestamp:chain.timestamp,lesson:"Compare this outcome with the entry thesis. A profitable result does not prove that the process was sound."});
        }catch(e){await record("exit_blocked",{positionId:position.id,reason:(e as Error).message});}
      }
      if(!rules.enabled||positions.length>=plan.layers.length)return;
      const block=async(reason:string)=>record("wait",{reason});
      if(process.env.PAPER_ENTRY_ENABLED==="false")return block("Entries locked off by deployment configuration");
      if(!entryWindow(now()).allowed)return block(entryWindow(now()).reason);
      if(!settings?.auto_trade_enabled)return block("Master auto-entry switch is off");
      if(positions.some(p=>p.status==="closed"))return block("A layer has exited; no further adds in this campaign");
      const review=await latestStrategyReview(plan.symbol,"debit_spread",tx);
      if(!currentReview(review,now())||review.assessment.status!=="go"||review.direction!==plan.direction)return block("Missing, expired or failed matching directional review");
      if(positions.some(p=>now().getTime()-new Date(p.opened_at).getTime()<600000))return block("Minimum ten-minute spacing between layers");
      const index=positions.length,l=plan.layers[index],trigger=rules.triggers[index],et=eastern(now());
      if(l.expiration<=et.date||!session(l.expiration).open)return block("No new expiration-day or unsupported-expiration entries");
      if(!Number.isFinite(chain.spot)||!trigger||(trigger.comparison==="above"?chain.spot<trigger.spot:chain.spot>trigger.spot))return block("Declared underlying price trigger not met");
      try{
        for(const p of positions){const mark=spreadQuote(chain,plan.layers[p.layer_index]).exit-rules.slippagePerSpread;
          if((mark-Number(p.entry_debit))*100*plan.layers[p.layer_index].contracts-Number(p.entry_fees)-2*plan.layers[p.layer_index].contracts*rules.feePerContractLeg<=0)return block("No averaging down: existing layers must show positive net liquidation P&L");}
        const q=spreadQuote(chain,l),debit=q.entry+rules.slippagePerSpread,fees=2*l.contracts*rules.feePerContractLeg;
        const reward=(l.targetCredit-debit)*100*l.contracts-2*fees,risk=(debit-l.stopCredit)*100*l.contracts+2*fees;
        if(debit>l.debit||debit>=q.width||reward<=0||risk<=0||reward/risk<1.5)return block("Executable price exceeds planned limit or cost-adjusted reward/risk is below 1.5");
        const global=(await tx.execute(sql`SELECT COALESCE(sum(entry_debit*contracts*100+entry_fees),0) AS risk FROM spread_positions WHERE status='open'`)).rows[0];
        const flyRisk=(await tx.execute(sql`SELECT COALESCE(sum(max_loss),0) AS risk FROM flies WHERE status='open'`)).rows[0];
        const thisRisk=debit*100*l.contracts+fees;
        if(Number(global.risk)+Number(flyRisk.risk)+thisRisk>settings.account_balance*settings.risk_per_trade_percent/100)return block("Combined full-debit risk exceeds account budget");
        if(positions.reduce((s,p)=>s+Number(p.entry_debit)*100*p.contracts+Number(p.entry_fees),0)+thisRisk>plan.riskCap)return block("Campaign debit plus costs exceeds declared risk cap");
        if(!executable){await record("would_enter",{layer:index+1,debit,reviewId:review.id});return;}
        const inserted=await tx.execute(sql`INSERT INTO spread_positions(plan_id,layer_index,symbol,contracts,entry_debit,entry_fees,opened_at,entry_evidence)
          VALUES(${row.id},${index},${plan.symbol},${l.contracts},${debit},${fees},${now().toISOString()},${JSON.stringify({reviewId:review.id,review,trigger,spot:chain.spot,quoteTimestamp:chain.timestamp,rules,thesis:plan.thesis,layer:l,policy:"paper-spread-v1"})}::jsonb)
          ON CONFLICT(plan_id,layer_index) DO NOTHING RETURNING id`);
        if(inserted.rows.length)await record("entry",{positionId:inserted.rows[0].id,layer:index+1,debit,fees,reviewId:review.id,reason:"Matching GO review, numeric trigger, fresh two-leg quote and risk checks passed",thesis:plan.thesis});
      }catch(e){await block((e as Error).message);}
    });
  }
  return {outcome:"evaluated",decisions:outcomes};
}
