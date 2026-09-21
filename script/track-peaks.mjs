// Replacement for the legacy Render command, which incorrectly exited 0 on HTTP errors.
const secret=process.env.CRON_SECRET;
if(!secret || secret.length<16) throw Error("CRON_SECRET is missing or too short");
const base=process.env.WINGWALL_BASE_URL??"https://wingwall.onrender.com";
const response=await fetch(`${base}/api/track-all-open-peaks`,{
  method:"POST",headers:{"x-cron-secret":secret},signal:AbortSignal.timeout(90_000),
});
if(!response.ok) throw Error(`Peak tracking HTTP ${response.status}`);
const body=await response.json();
if(body.degraded || !Array.isArray(body.results) || body.results.some(r=>r.error || r.skipped)) throw Error("Peak tracking degraded");
console.log(JSON.stringify({checked:body.checked,healthy:true}));
