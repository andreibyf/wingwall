import {z} from "zod";

const text=z.string().max(4000);
const price=z.number().finite().nonnegative().nullable();
export const recommendationDraftSchema=z.object({
  title:z.string().min(1).max(160),
  symbol:z.enum(["QQQ","SPY","MES"]),
  strategy:z.enum(["butterfly","debit_spread","wait"]),
  direction:z.enum(["bullish","bearish","range","unknown"]),
  thesis:text,
  entryCondition:text,
  exitPlan:text,
  invalidation:text,
  riskCap:price,
  suggestedDebit:price,
  targetCredit:price,
  stopCredit:price,
  legs:z.array(z.object({
    side:z.enum(["buy","sell"]),
    optionType:z.enum(["call","put"]),
    strike:z.number().finite().positive().nullable(),
    expiration:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    ratio:z.number().int().min(1).max(10),
  }).strict()).max(30),
  evidence:z.array(z.string().max(1000)).max(30),
  missingEvidence:z.array(z.string().max(1000)).max(30),
}).strict();
export type RecommendationDraft=z.infer<typeof recommendationDraftSchema>;
export const draftTool={
  name:"save_recommendation_draft",
  description:"Populate a new editable recommendation draft when the operator asks you to plug in, prepare, save or draft a setup. Never executes, approves evidence, arms automation or changes existing plans. Unknown inputs must be null or explicitly missing.",
  input_schema:z.toJSONSchema(recommendationDraftSchema,{target:"draft-7"}),
};
