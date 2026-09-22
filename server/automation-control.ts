import {sql} from "drizzle-orm";
import {db} from "./storage";
import {paperMode as defaultMode} from "./automation-policy";

export async function automationControl(connection:any=db) {
  const row=(await connection.execute(sql`SELECT mode,version,updated_at AS "updatedAt" FROM automation_control WHERE id=1`)).rows[0];
  if(!row)throw Error("Automation control missing; execution is blocked");
  const forcedObserve=process.env.PAPER_AUTOMATION_FORCE_OBSERVE==="true";
  return {mode:forcedObserve?"observe":row.mode??defaultMode(),version:Number(row.version),
    source:forcedObserve?"deployment override":row.mode?"operator selection":"deployment default",
    forcedObserve,updatedAt:row.updatedAt};
}
export async function paperMode(connection:any=db):Promise<"observe"|"paper"> {
  return (await automationControl(connection)).mode;
}
export async function setAutomationMode(mode:"observe"|"paper",version:number) {
  return db.transaction(async tx=>{
    // All execution ledgers take the settings lock before checking the effective mode.
    // Once this commits, an in-flight proposal cannot commit under the previous mode.
    await tx.execute(sql`LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE`);
    const old=await automationControl(tx);
    if(old.version!==version)throw Object.assign(Error("Automation mode changed. Refresh and review again."),{status:409});
    if(mode==="paper"&&old.forcedObserve)throw Object.assign(Error("Deployment forces Observe mode. Paper mode is locked."),{status:409});
    await tx.execute(sql`UPDATE settings SET auto_trade_enabled=false WHERE id=1`);
    await tx.execute(sql`UPDATE automation_control SET mode=${mode},version=version+1,updated_at=now() WHERE id=1`);
    await tx.execute(sql`INSERT INTO automation_mode_events(previous_mode,new_mode,detail)
      VALUES(${old.mode},${mode},'Operator confirmed mode selection; new entries disarmed; no position or draft changes')`);
    return automationControl(tx);
  });
}
