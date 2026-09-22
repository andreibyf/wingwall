import {sql} from "drizzle-orm";
import {z} from "zod";
import type {Express} from "express";
import {db} from "./storage";
import {recommendationDraftSchema} from "../shared/recommendation-draft";

export async function draftForRequest(requestId:string) {
  const r=await db.execute(sql`SELECT id,payload,version,created_at AS "createdAt",updated_at AS "updatedAt"
    FROM recommendation_drafts WHERE request_id=${requestId}`);
  return r.rows[0]??null;
}
export async function saveRecommendationDraft(input:unknown,requestId:string,model:string) {
  const payload=recommendationDraftSchema.parse(input);
  // A dedicated table, deliberately not read by any entry/exit worker.
  await db.execute(sql`INSERT INTO recommendation_drafts(request_id,payload,original_payload,model)
    VALUES(${requestId},${JSON.stringify(payload)}::jsonb,${JSON.stringify(payload)}::jsonb,${model})
    ON CONFLICT(request_id) DO NOTHING`);
  return draftForRequest(requestId);
}
export function registerDraftRoutes(app:Express) {
  app.get("/api/copilot/drafts",async(_req,res,next)=>{
    try {
      const r=await db.execute(sql`SELECT id,payload,original_payload AS "originalPayload",model,version,
        created_at AS "createdAt",updated_at AS "updatedAt" FROM recommendation_drafts ORDER BY id DESC LIMIT 50`);
      res.json(r.rows);
    }catch(e){next(e);}
  });
  app.patch("/api/copilot/drafts/:id",async(req,res,next)=>{
    try {
      const id=z.coerce.number().int().positive().parse(req.params.id);
      const {payload,version}=z.object({payload:recommendationDraftSchema,version:z.number().int().positive()}).strict().parse(req.body);
      const r=await db.execute(sql`UPDATE recommendation_drafts SET payload=${JSON.stringify(payload)}::jsonb,
        version=version+1,updated_at=now() WHERE id=${id} AND version=${version}
        RETURNING id,payload,version,updated_at AS "updatedAt"`);
      if(!r.rows[0])return res.status(409).json({message:"Draft changed or no longer exists. Reload drafts before editing."});
      res.json(r.rows[0]);
    }catch(e){next(e);}
  });
}
