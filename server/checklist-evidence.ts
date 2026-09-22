import type {Express} from "express";
import {z} from "zod";
import {db,getCachedLevels} from "./storage";
import {sql} from "drizzle-orm";
import {buildChecklistEvidence} from "../shared/checklist-evidence";

export function registerChecklistEvidence(app:Express,fetchChain:(symbol:string)=>Promise<any>){
  app.get("/api/strategy/evidence",async(req,res,next)=>{
    try{
      const q=z.object({symbol:z.enum(["QQQ","SPY"]),strategy:z.enum(["butterfly","debit_spread"]),
        draftId:z.coerce.number().int().positive().optional()}).strict().parse(req.query);
      let draft:any;
      if(q.draftId){
        const r=await db.execute(sql`SELECT id,payload,created_at AS "createdAt",updated_at AS "updatedAt" FROM recommendation_drafts WHERE id=${q.draftId}`);
        draft=r.rows[0];
        if(!draft||draft.payload.symbol!==q.symbol||![q.strategy,"wait"].includes(draft.payload.strategy))
          return res.status(409).json({message:"Draft does not match this symbol and strategy. Select another draft."});
      }
      // No provider refresh of scarce Gexbot quota and no database writes.
      const [g,c]=await Promise.allSettled([getCachedLevels(q.symbol),fetchChain(q.symbol)]);
      res.setHeader("Cache-Control","no-store");
      res.json(buildChecklistEvidence({...q,draft,
        gex:g.status==="fulfilled"?g.value:null,gexError:g.status==="rejected",
        chain:c.status==="fulfilled"?c.value:null,chainError:c.status==="rejected"}));
    }catch(e){next(e);}
  });
}
