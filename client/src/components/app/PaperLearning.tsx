import {useState} from "react";
import {useQuery,useMutation} from "@tanstack/react-query";
import {apiRequest,queryClient} from "@/lib/queryClient";
import {Button} from "@/components/ui/button";
const field="w-full rounded border border-input bg-background p-2 text-sm";
const panel="rounded-lg border border-border bg-card p-4 space-y-4";
function PlanRules({plan,existing,onSave}:{plan:any;existing:any;onSave:(id:number,body:any)=>void}){
  const [rules,setRules]=useState(existing??{enabled:false,triggers:plan.payload.layers.map(()=>({comparison:"above",spot:0})),feePerContractLeg:0.65,slippagePerSpread:0.02});
  return <details className="rounded border border-border p-3">
    <summary className="cursor-pointer text-sm">Plan #{plan.id} paper rules · {existing?.enabled?"enabled":"disabled"}</summary>
    <div className="mt-3 space-y-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rules.enabled} onChange={e=>setRules({...rules,enabled:e.target.checked})}/>Enable this plan for paper decisions</label>
      {rules.triggers.map((t:any,i:number)=><div key={i} className="grid grid-cols-2 gap-2">
        <label className="text-sm">Layer {i+1} underlying condition<select aria-label={`Plan ${plan.id} layer ${i+1} comparison`} className={field} value={t.comparison} onChange={e=>setRules({...rules,triggers:rules.triggers.map((v:any,j:number)=>j===i?{...v,comparison:e.target.value}:v)})}><option value="above">At or above</option><option value="below">At or below</option></select></label>
        <label className="text-sm">Spot threshold<input aria-label={`Plan ${plan.id} layer ${i+1} spot`} className={field} type="number" step="0.01" value={t.spot||""} onChange={e=>setRules({...rules,triggers:rules.triggers.map((v:any,j:number)=>j===i?{...v,spot:Number(e.target.value)}:v)})}/></label>
      </div>)}
      <div className="grid grid-cols-2 gap-2">{[["feePerContractLeg","Fee / contract / leg / side"],["slippagePerSpread","Extra spread slippage / share / side"]].map(([key,label])=><label key={key} className="text-sm">{label}<input className={field} type="number" min="0" step="0.01" value={rules[key]} onChange={e=>setRules({...rules,[key]:Number(e.target.value)})}/></label>)}</div>
      <p className="text-xs text-muted-foreground">Simulated buys use long ask minus short bid plus slippage; sells use long bid minus short ask minus slippage. Plan debit is the entry limit. Target/stop use liquidation credit. One layer per evaluation, at least ten minutes apart; no averaging down or adds after an exit. Costs and exits freeze after first entry.</p>
      <Button disabled={rules.triggers.some((t:any)=>t.spot<=0)} onClick={()=>onSave(plan.id,rules)}>Save paper automation rules</Button>
    </div>
  </details>;
}
export function PaperLearning({plans}:{plans:any[]}){
  const {data,error}=useQuery<any>({queryKey:["/api/learning"],refetchInterval:30_000});
  const [message,setMessage]=useState(""),[positionId,setPositionId]=useState(""),[reflection,setReflection]=useState("");
  const save=useMutation({mutationFn:async({path,body}:{path:string;body:any})=>(await apiRequest("POST",path,body)).json(),
    onSuccess:(result)=>{setMessage(result.message??"Reflection saved for future chat context.");queryClient.invalidateQueries({queryKey:["/api/learning"]});},
    onError:(e:Error)=>setMessage(e.message)});
  return <section className={panel}>
    <h3 className="font-semibold">Paper decisions and learning journal</h3>
    <p className="text-sm text-muted-foreground">Learn the process as well as the result. Plans remain scenarios until explicitly armed and recorded by the paper worker. No real orders are sent. Chat explains and reviews; deterministic rules control simulation.</p>
    {error&&<p role="alert">Learning records unavailable. Do not assume automation is ready.</p>}
    {data&&<>
      <p className="text-sm">Mode: <strong>{data.mode}</strong>. Entries also require the Settings auto-entry switch, a current GO review and quotes no older than two minutes. Disabling a plan stops adds, not exits. Entry window: Monday–Wednesday, 09:45–10:30 Eastern. Exit checks run during market hours.</p>
      <div className="grid gap-3 md:grid-cols-3">{[
        ["Before entry","Explain why this structure fits, what would invalidate it, the trigger, price limit, total risk and exit plan."],
        ["During the trade","Observe whether evidence still supports the thesis. Distinguish a rule-based hold from missing data; never assume stale marks are current."],
        ["After exit","Compare the plan with the action. Was the process sound, regardless of profit? Save one testable lesson, not a new rule based on one outcome."]
      ].map(([title,text])=><div key={title} className="rounded bg-muted p-3 text-sm"><h4 className="font-semibold">{title}</h4><p className="mt-2 text-muted-foreground">{text}</p></div>)}</div>
      <div className="rounded bg-muted p-3 text-sm" data-testid="learning-summary">
        <p>Spread ledger: {data.summary.open} open · {data.summary.closed} closed · realized net ${data.summary.realizedNet.toFixed(2)} · win rate {data.summary.winRate===null?"not available":`${(100*data.summary.winRate).toFixed(1)}%`} · profit factor {data.summary.profitFactor===null?"not available":data.summary.profitFactor.toFixed(2)}</p>
        <p className="mt-2 text-muted-foreground">{data.summary.caveat} Butterfly results remain in Overview. This is not a combined account total.</p>
      </div>
      {plans.map(p=><PlanRules key={`${p.id}:${JSON.stringify(data.rules.find((r:any)=>r.plan_id===p.id)?.payload)}`} plan={p} existing={data.rules.find((r:any)=>r.plan_id===p.id)?.payload} onSave={(id,body)=>save.mutate({path:`/api/strategy/plans/${id}/automation`,body})}/>)}
      <h4 className="text-sm font-semibold">Recorded paper positions</h4>
      {!data.positions.length&&<p className="text-sm text-muted-foreground">No paper spread positions yet. Saving a plan is not a fill.</p>}
      {data.positions.map((p:any)=><details key={p.id} className="rounded border border-border p-3 text-sm">
        <summary>Spread #{p.id} · plan {p.plan_id}, layer {p.layer_index+1} · {p.symbol} · {p.status} · {p.realized_pnl===null?"P&L not realized":`net $${Number(p.realized_pnl).toFixed(2)}`}</summary>
        <p className="mt-2">Entry debit {p.entry_debit} · fees ${p.entry_fees} · {new Date(p.opened_at).toLocaleString()} · review #{p.entry_evidence.reviewId}</p>
        <p>Thesis: {p.entry_evidence.thesis}</p><p>Exit: {p.exit_reason??"No exit recorded"}</p>
        <p>Last liquidation mark: {p.mark_credit??"unavailable"} at {p.mark_at??"unavailable"}; not necessarily current.</p>
      </details>)}
      <label className="grid gap-1 text-sm">Position to review<select aria-label="Position to review" className={field} value={positionId} onChange={e=>setPositionId(e.target.value)}><option value="">Choose a recorded spread</option>{data.positions.map((p:any)=><option key={p.id} value={p.id}>Spread #{p.id} · {p.status}</option>)}</select></label>
      <label className="grid gap-1 text-sm">What did you learn?<textarea className={field} rows={3} value={reflection} onChange={e=>setReflection(e.target.value)} placeholder="Expected versus observed; rule followed or missed; one hypothesis to test next time."/></label>
      <Button disabled={!positionId||reflection.trim().length<10||save.isPending} onClick={()=>save.mutate({path:"/api/learning/reflections",body:{positionId:Number(positionId),text:reflection}})}>Save learning reflection</Button>
      <p className="text-xs text-muted-foreground">Chat retrieves these records and reflections in future responses. This is not model retraining; it will not change your risk limits or strategy rules on its own.</p>
      {data.reflections.map((r:any)=><p key={r.id} className="text-sm">Spread #{r.position_id}: {r.text}</p>)}
      <details><summary className="cursor-pointer text-sm">Recent automatic decisions, including waits</summary><div className="mt-3 space-y-2">{data.decisions.map((d:any)=><div key={d.id} className="rounded bg-muted p-2 text-sm">Plan #{d.plan_id} · {d.action} · {new Date(d.created_at).toLocaleString()}<p className="text-muted-foreground">{d.detail.reason??d.detail.lesson??"Configuration saved"}</p></div>)}</div></details>
    </>}
    {message&&<p role="status" className="text-sm">{message}</p>}
  </section>;
}
