// Bounded exchange calendar. Unknown years fail closed until reviewed.
// NYSE published 2026/2027 holiday and early-close dates.
// https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx
// Intentionally uses the underlying equity close (not options' extra 15 minutes).
const CLOSED = new Set([
  "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
  "2027-01-01","2027-01-18","2027-02-15","2027-03-26","2027-05-31","2027-06-18","2027-07-05","2027-09-06","2027-11-25","2027-12-24",
]);
const EARLY = new Set(["2026-11-27","2026-12-24","2027-11-26"]);
export function eastern(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23",
  }).formatToParts(now).map(p=>[p.type,p.value]));
  return { date:`${parts.year}-${parts.month}-${parts.day}`, minute:Number(parts.hour)*60+Number(parts.minute) };
}
export function session(date: string) {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  const supported = /^(2026|2027)-\d\d-\d\d$/.test(date);
  return { supported, open:supported && dow>0 && dow<6 && !CLOSED.has(date),
    close:EARLY.has(date)?780:960, dow };
}
export function campaignWeek(date: string) {
  const d=new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate()+(d.getUTCDay()===0?-6:1-d.getUTCDay()));
  const monday=d.toISOString().slice(0,10);
  d.setUTCDate(d.getUTCDate()+3);
  return {monday,expiration:d.toISOString().slice(0,10)};
}
export function entryWindow(now = new Date()) {
  const et=eastern(now), s=session(et.date), week=campaignWeek(et.date);
  if (!s.supported) return {allowed:false,reason:"Calendar year not reviewed",...et,...week};
  if (!s.open) return {allowed:false,reason:"Exchange closed",...et,...week};
  if (s.dow>3) return {allowed:false,reason:"No fresh Thursday or Friday entries",...et,...week};
  if (!session(week.expiration).open) return {allowed:false,reason:"Thursday expiry is a holiday; manual campaign review required",...et,...week};
  if (et.minute<585 || et.minute>=630) return {allowed:false,reason:"Outside 09:45–10:30 Eastern entry window",...et,...week};
  return {allowed:true,reason:"Entry window open",...et,...week};
}
export function marketOpen(now = new Date()) {
  const et=eastern(now), s=session(et.date);
  return s.open && et.minute>=570 && et.minute<s.close;
}
export function remainingSessions(date:string, expiration:string) {
  let days=0;
  for(let d=new Date(`${date}T12:00:00Z`);d.toISOString().slice(0,10)<expiration;d.setUTCDate(d.getUTCDate()+1)) {
    if(session(d.toISOString().slice(0,10)).open) days++;
  }
  return Math.max(1,days);
}
// Automated decisions require <=2-minute quotes. Delayed feeds may be displayed,
// but cannot silently become execution-quality observations.
export function freshQuote(timestamp: unknown, now = new Date()) {
  if(typeof timestamp!=="string" || !/(Z|[+-]\d\d:\d\d)$/.test(timestamp)) return false;
  const age=now.getTime()-Date.parse(timestamp);
  return Number.isFinite(age) && age>=-30_000 && age<=120_000;
}
export function paperMode() {
  return process.env.PAPER_AUTOMATION_MODE==="paper" ? "paper" : "observe";
}
export function exitReason(fly: any, mid:number, settings:any, now = new Date()):string|null {
  if(!marketOpen(now) || !Number.isFinite(mid) || mid<0) return null;
  if(!settings || !Number.isFinite(settings.takeProfitValue) || settings.takeProfitValue<=0 ||
    !Number.isFinite(settings.stopLossPctOfMaxLoss) || settings.stopLossPctOfMaxLoss>=0 ||
    !Number.isFinite(fly.maxLoss) || fly.maxLoss<=0 || !Number.isInteger(fly.contracts) || fly.contracts<1) return null;
  const et=eastern(now), s=session(et.date);
  if(fly.expiration<et.date) return null; // Never invent an expired settlement.
  if(fly.expiration===et.date && et.minute>=s.close-15) return "expiry-curfew";
  if(s.dow===5 && et.minute>=Math.min(840,s.close-15)) return "friday-curfew";
  const pnl=(mid-fly.entryDebit)*100*fly.contracts;
  const tp=settings.takeProfitMode==="pctOfMaxProfit"
    ? pnl>=fly.maxProfit*settings.takeProfitValue
    : mid>=fly.entryDebit*settings.takeProfitValue;
  if(tp) return "take-profit";
  if(fly.maxLoss>0 && pnl/fly.maxLoss<=settings.stopLossPctOfMaxLoss) return "stop-loss";
  return null;
}
