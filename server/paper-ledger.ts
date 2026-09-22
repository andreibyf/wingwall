import { sql, eq } from "drizzle-orm";
import { db } from "./storage";
import { flies, journalNotes, settings, campaignWalls, type InsertFly } from "../shared/schema";
import { entryWindow, freshQuote, paperMode, eastern, exitReason } from "./automation-policy";
import { operatorConfigured } from "./operator-auth";
import { assertButterflyReview } from "./strategy-store";

const fail=(message:string)=>Object.assign(new Error(message),{status:409});
export async function commitPaperEntry(input:{
  fly:InsertFly; journal:string; settingsSnapshot:unknown; wallSnapshot:unknown;
  quoteTimestamp:string; now?:()=>Date;
}) {
  return db.transaction(async tx=>{
    // Locks also serialize with manual INSERT/PATCH/DELETE endpoints, not just workers.
    await tx.execute(sql`LOCK TABLE settings, campaign_walls, flies, strategy_reviews IN SHARE ROW EXCLUSIVE MODE`);
    const now=(input.now??(()=>new Date()))(), window=entryWindow(now);
    if(paperMode()!=="paper" || !operatorConfigured() || !window.allowed || !freshQuote(input.quoteTimestamp,now)) throw fail("Paper entry no longer authorized, in-window, or fresh");
    const [current]=await tx.select().from(settings).where(eq(settings.id,1));
    if(!current?.autoTradeEnabled || JSON.stringify(current)!==JSON.stringify(input.settingsSnapshot)) throw fail("Settings changed or entry disarmed during review");
    if(!Number.isFinite(input.fly.maxLoss) || input.fly.maxLoss<=0 ||
      input.fly.maxLoss>current.accountBalance*current.riskPerTradePercent/100 ||
      !Number.isInteger(input.fly.contracts) || Number(input.fly.contracts)<1 ||
      !Number.isFinite(input.fly.entryDebit) || input.fly.entryDebit<=0) throw fail("Entry exceeds risk budget or has invalid economics");
    const [wall]=await tx.select().from(campaignWalls).where(eq(campaignWalls.id,input.fly.campaignWallId!));
    if(!wall || wall.symbol!==input.fly.symbol || wall.weekOf!==window.monday || JSON.stringify(wall)!==JSON.stringify(input.wallSnapshot)) throw fail("Campaign changed during review");
    const existing=await tx.select().from(flies);
    if(existing.some(f=>f.status==="open")) throw fail("A position is already open");
    if(existing.some(f=>f.symbol===input.fly.symbol && f.entryDate>=window.monday && f.entryDate<=window.expiration)) throw fail("An entry already exists this campaign week");
    const claimed=await tx.execute(sql`SELECT 1 FROM paper_entry_claims WHERE symbol=${input.fly.symbol} AND week_of=${window.monday}`);
    if(claimed.rows.length) throw fail("Campaign entry already claimed");
    if(input.fly.expiration!==window.expiration || input.fly.entryDate!==window.date) throw fail("Proposal date no longer current");
    const review=await assertButterflyReview(input.fly.symbol,now,tx);
    const [fly]=await tx.insert(flies).values({...input.fly,createdAt:now.toISOString()}).returning();
    await tx.execute(sql`INSERT INTO paper_entry_claims(symbol,week_of,fly_id) VALUES(${fly.symbol},${window.monday},${fly.id})`);
    const [note]=await tx.insert(journalNotes).values({date:window.date,category:"general",text:`Paper entry Fly ${fly.id}, mentor review ${review.id}. ${input.journal}`,createdAt:now.toISOString()}).returning();
    return {flyId:fly.id,journalNoteId:note.id};
  });
}
export async function commitPaperExit(input:{flyId:number; mid:number; timestamp:string; source:string; now?:()=>Date}) {
  return db.transaction(async tx=>{
    await tx.execute(sql`LOCK TABLE settings, flies IN SHARE ROW EXCLUSIVE MODE`);
    const now=(input.now??(()=>new Date()))();
    if(paperMode()!=="paper" || !operatorConfigured() || process.env.PAPER_EXIT_ENABLED==="false" || !freshQuote(input.timestamp,now)) throw fail("Paper exit not authorized or quote stale");
    const [fly]=await tx.select().from(flies).where(eq(flies.id,input.flyId));
    if(!fly || fly.status!=="open") return {outcome:"already_closed",flyId:input.flyId};
    if(!["QQQ","SPY"].includes(fly.symbol)) throw fail("Unsupported automatic settlement symbol");
    if(input.mid>Math.max(fly.middleStrike-fly.lowerStrike,fly.upperStrike-fly.middleStrike)) throw fail("Quote exceeds structure payoff ceiling");
    const [current]=await tx.select().from(settings).where(eq(settings.id,1));
    if(!current) throw fail("Missing exit policy");
    const reason=exitReason(fly,input.mid,current,now);
    if(!reason) throw fail("Exit trigger no longer applies");
    const date=eastern(now).date, debit=Math.round(input.mid*100)/100;
    await tx.update(flies).set({status:"closed",exitDebit:debit,exitDate:date}).where(eq(flies.id,fly.id));
    await tx.insert(journalNotes).values({date,category:"general",createdAt:now.toISOString(),
      text:`Paper exit Fly ${fly.id}: ${reason}, simulated mid $${debit}. Quote ${input.timestamp}, source ${input.source}. No broker order or fill.`});
    return {outcome:"closed",flyId:fly.id,reason};
  });
}
