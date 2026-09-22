import {sql} from "drizzle-orm";
import {db,storage} from "./storage";
import {CHECKLIST_VERSION,currentReview,evaluateReview,reviewSchema,layerPlanSchema,calculateLayerPlan,type Strategy} from "../shared/strategy-policy";
import type {Express} from "express";
import {registerLearningRoutes,learningSnapshot} from "./spread-learning";
const fail=(message:string)=>Object.assign(new Error(message),{status:409});
export async function latestStrategyReview(symbol:string,strategy:Strategy,connection:any=db) {
  const result=await connection.execute(sql`SELECT id,payload,created_at AS "createdAt",version
    FROM strategy_reviews WHERE symbol=${symbol} AND strategy=${strategy} ORDER BY id DESC LIMIT 1`);
  const row=result.rows[0];
  return row?{...row,...row.payload,assessment:evaluateReview(row.payload)}:null;
}
export async function assertButterflyReview(symbol:string,now=new Date(),connection:any=db) {
  const review=await latestStrategyReview(symbol,"butterfly",connection);
  if(!review || !currentReview(review,now) || review.assessment.status!=="go")
    throw fail("Butterfly entry blocked: save a current GO mentor checklist in Strategy. Negative gamma, no-go or missing evidence means wait.");
  return review;
}
export async function strategySnapshot() {
  const reviews=await db.execute(sql`SELECT DISTINCT ON(symbol,strategy) id,payload,created_at AS "createdAt",version
    FROM strategy_reviews ORDER BY symbol,strategy,id DESC`);
  const plans=await db.execute(sql`SELECT id,payload,created_at AS "createdAt" FROM spread_plans ORDER BY id DESC LIMIT 20`);
  return {reviews:reviews.rows.map((r:any)=>({...r,...r.payload,current:currentReview(r),assessment:evaluateReview(r.payload)})),
    plans:plans.rows,learning:await learningSnapshot(),spreadExecution:"Saved plans are not positions. Explicit numeric paper rules plus master switch, paper mode, current review and fresh quotes are required. Exits run independently of entry arming."};
}
export function registerStrategyRoutes(app:Express) {
  registerLearningRoutes(app);
  app.get("/api/strategy",async(_req,res,next)=>{try{res.json(await strategySnapshot());}catch(e){next(e);}});
  app.post("/api/strategy/reviews",async(req,res,next)=>{
    try {
      const input=reviewSchema.parse(req.body);
      // Serialize with entry transactions; a new NO-GO cannot race a committed entry.
      const result=await db.transaction(async tx=>{
        await tx.execute(sql`LOCK TABLE strategy_reviews IN SHARE ROW EXCLUSIVE MODE`);
        const r=await tx.execute(sql`INSERT INTO strategy_reviews(symbol,strategy,payload,version)
          VALUES(${input.symbol},${input.strategy},${JSON.stringify(input)}::jsonb,${CHECKLIST_VERSION})
          RETURNING id,created_at AS "createdAt"`);
        return {...r.rows[0],...input,version:CHECKLIST_VERSION,assessment:evaluateReview(input)};
      });
      res.status(201).json(result);
    }catch(e){next(e);}
  });
  app.post("/api/strategy/plans",async(req,res,next)=>{
    try {
      const plan=layerPlanSchema.parse(req.body),calc=calculateLayerPlan(plan);
      if(!calc.valid)throw fail(calc.issues.join("; "));
      // Plans deliberately remain saveable with failed/missing reviews: never a fill.
      const s=await storage.getSettings();
      const open= (await storage.listFlies()).filter(f=>f.status==="open").reduce((sum,f)=>sum+f.maxLoss,0);
      const budget=s.accountBalance*s.riskPerTradePercent/100;
      const riskWarning=open+calc.totalMaxLoss>budget?"If all layers were entered, existing butterfly risk plus this plan would exceed the current account risk budget.":"Combined risk is within the current configured budget (planning estimate only).";
      const review=await latestStrategyReview(plan.symbol,"debit_spread");
      const payload={...plan,calculation:calc,reviewId:review?.id??null,reviewCurrent:currentReview(review),
        reviewStatus:review?.direction===plan.direction?review.assessment.status:"incomplete",
        existingOpenFlyRisk:open,accountRiskBudget:budget,riskWarning,status:"plan_only"};
      const result=await db.execute(sql`INSERT INTO spread_plans(payload) VALUES(${JSON.stringify(payload)}::jsonb) RETURNING id,created_at AS "createdAt"`);
      res.status(201).json({...result.rows[0],payload});
    }catch(e){next(e);}
  });
}
