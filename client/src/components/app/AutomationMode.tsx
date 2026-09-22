import {useState} from "react";
import {useMutation} from "@tanstack/react-query";
import {apiRequest,queryClient} from "@/lib/queryClient";
import {Button} from "@/components/ui/button";

export function AutomationMode({status}:{status:any}) {
  const [pending,setPending]=useState<{mode:string;version:number}|null>(null);
  const [ack,setAck]=useState(false),[message,setMessage]=useState("");
  const save=useMutation({
    mutationFn:async()=> {
      if(!pending||!ack)throw Error("Review and confirm the mode change first.");
      return (await apiRequest("PUT","/api/automation/mode",{...pending,acknowledge:true})).json();
    },
    onSuccess:r=>{
      setPending(null);setAck(false);setMessage(r.message);
      queryClient.invalidateQueries({queryKey:["/api/automation/status"]});
      queryClient.invalidateQueries({queryKey:["/api/settings"]});
      queryClient.invalidateQueries({queryKey:["/api/learning"]});
    },
    onError:(e:Error)=>setMessage(e.message),
  });
  return <div className="space-y-3 rounded-md border border-border p-3">
    {status?.demo&&<p role="status" className="text-sm font-medium">Isolated demo only. Mode changes here cannot affect production or execute trades.</p>}
    <label className="grid gap-1 text-sm font-medium">Automation mode
      <select aria-label="Automation mode" className="w-full rounded-md border border-input bg-background p-2 text-sm"
        disabled={!status?.modeControl||save.isPending} value={pending?.mode??status?.mode??"observe"}
        onChange={e=>{setPending({mode:e.target.value,version:status.modeControl.version});setAck(false);setMessage("");}}>
        <option value="observe">Observe — evaluate only</option>
        <option value="paper" disabled={status?.modeControl?.forcedObserve}>Paper automation — simulated fills</option>
      </select>
    </label>
    <p className="text-sm">Effective mode: <strong>{status?.mode??"checking"}</strong> · Entry lock: <strong>{status?.entryLocked===true?"locked by deployment":status?.entryLocked===false?"unlocked":"checking"}</strong></p>
    <p className="text-xs text-muted-foreground">Mode source: {status?.modeControl?.source??"checking"}. No real-order mode exists. Draft recommendations cannot execute.</p>
    {status?.modeControl?.forcedObserve&&<p role="alert" className="text-sm">Deployment forces Observe mode; UI cannot override it.</p>}
    {pending&&<div role="region" aria-label="Confirm automation mode change" className="space-y-3 rounded bg-muted p-3">
      <h3 className="text-sm font-semibold">Review mode change</h3>
      <p className="text-sm">{pending.mode==="paper"
        ?"Paper mode permits automatic simulated exits for existing positions when enabled and valid triggers and fresh quotes are available. New entries will be switched OFF; arm them separately only after resolving blockers."
        :"Observe mode stops automatic simulated entries AND exits. Existing paper positions stay open and will not have automatic exit protection. To stop only new entries, leave Paper mode active and turn Auto entry off instead."}</p>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} disabled={save.isPending}/>I understand the effect on entries and exits. Apply this mode only.</label>
      <div className="flex gap-2"><Button disabled={!ack||save.isPending} onClick={()=>save.mutate()}>Confirm mode change</Button>
        <Button variant="outline" disabled={save.isPending} onClick={()=>{setPending(null);setAck(false);setMessage("");}}>Cancel</Button></div>
    </div>}
    <div className="text-sm space-y-1"><h3 className="font-medium">Entry readiness blockers</h3>
      {!status&&<p>Readiness unavailable. Do not rely on unattended automation.</p>}
      {status?.blockers?.map((b:string)=><p key={b}>• {b}</p>)}
      {status?.blockers?.length===0&&<p>No global blockers reported. This is not approval of an individual setup.</p>}
      <p className="text-xs text-muted-foreground">{status?.quoteReadiness??"A heartbeat is not proof of fresh market data. Quotes and checklist evidence are verified per decision."}</p>
    </div>
    {message&&<p role="status" className="text-sm break-words">{message}</p>}
  </div>;
}
