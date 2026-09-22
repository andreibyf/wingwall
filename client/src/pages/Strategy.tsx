import {useState} from "react";
import {useQuery,useMutation} from "@tanstack/react-query";
import {apiRequest,queryClient} from "@/lib/queryClient";
import {Button} from "@/components/ui/button";
import {CHECKLISTS,reviewSchema,evaluateReview,layerPlanSchema,calculateLayerPlan,REVIEW_MINUTES,type Strategy as StrategyType,type ReviewInput,type LayerPlan} from "@shared/strategy-policy";

const field="w-full rounded-md border border-input bg-background p-2 text-sm";
const panel="rounded-lg border border-border bg-card p-4 md:p-5 space-y-4";
const emptyReview=(strategy:StrategyType):ReviewInput=>({symbol:"QQQ",strategy,direction:"unknown",gamma:"unknown",flipChop:"unknown",strongConfirmation:"unknown",checks:{},evidence:""});
const emptyLayer=()=>({optionType:"call" as const,expiration:"",longStrike:0,shortStrike:0,contracts:1,debit:0,targetCredit:0,stopCredit:0,addTrigger:""});
export default function Strategy(){
  const [review,setReview]=useState<ReviewInput>(emptyReview("butterfly"));
  const [plan,setPlan]=useState<LayerPlan>({symbol:"QQQ",direction:"bullish",riskCap:0,maxLayers:1,thesis:"",layers:[emptyLayer()]});
  const [message,setMessage]=useState("");
  const {data,isLoading,error}=useQuery<any>({queryKey:["/api/strategy"],refetchInterval:30_000});
  const assessment=evaluateReview(review),parsedPlan=layerPlanSchema.safeParse(plan);
  const calculation=parsedPlan.success?calculateLayerPlan(parsedPlan.data):null;
  const save=useMutation({
    mutationFn:async({path,body}:{path:string;body:unknown})=>(await apiRequest("POST",path,body)).json(),
    onSuccess:(_data,vars)=>{setMessage(vars.path.endsWith("reviews")?"Review saved. This is evidence, not execution authorization.":"Layer plan saved. No positions opened.");queryClient.invalidateQueries({queryKey:["/api/strategy"]});},
    onError:(e:Error)=>setMessage(e.message),
  });
  const select=(label:string,key:keyof ReviewInput,options:string[])=><label className="grid gap-1 text-sm">{label}<select aria-label={label} className={field} value={String(review[key])} onChange={e=>setReview({...review,[key]:e.target.value})}>{options.map(v=><option key={v} value={v}>{v.replaceAll("_"," ")}</option>)}</select></label>;
  const editLayer=(i:number,key:string,value:unknown)=>setPlan({...plan,layers:plan.layers.map((l,j)=>i===j?{...l,[key]:value}:l)});
  return <div className="mx-auto max-w-6xl space-y-6 pb-6">
    <div className="space-y-2"><p className="text-xs uppercase tracking-wider text-primary">Mentor playbook • paper only</p>
      <h2 className="text-xl font-semibold">Choose the setup. Keep “wait” available.</h2>
      <p className="max-w-3xl text-sm text-muted-foreground">Gamma first, then direction, path and payoff. A butterfly no-go is not a debit-spread approval. Unknown evidence stays unknown; the app does not infer live readings from checked boxes.</p>
    </div>
    <div className="grid gap-4 md:grid-cols-3">
      <div className={panel}><h3 className="font-semibold text-sm">Butterfly</h3><p className="text-sm text-muted-foreground">Positive gamma and stable price behavior. Negative gamma blocks the standard beginner setup.</p></div>
      <div className={panel}><h3 className="font-semibold text-sm">Debit spread</h3><p className="text-sm text-muted-foreground">Directional thesis and room to the short strike. Negative gamma requires stronger confirmation, not a free pass.</p></div>
      <div className={panel}><h3 className="font-semibold text-sm">Wait / no trade</h3><p className="text-sm text-muted-foreground">Flip-zone chop, a failed check, or missing evidence can rule out the setup. Do not force a structure.</p></div>
    </div>
    {data?.demo&&<p role="status" className="rounded border border-primary p-3 text-sm">Isolated preview only. Saves use temporary demo memory, not your production account. No feeds, workers or orders are connected.</p>}
    {error&&<p role="alert" className="text-destructive">Could not load saved evidence. Refresh before relying on a prior review.</p>}
    {isLoading&&<p className="text-sm">Loading saved reviews…</p>}
    <section className={panel}>
      <h3 className="font-semibold">Strategy checklist</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <label className="grid gap-1 text-sm">Strategy<select aria-label="Strategy" className={field} value={review.strategy} onChange={e=>{setReview(emptyReview(e.target.value as StrategyType));setMessage("");}}>
          <option value="butterfly">Butterfly</option><option value="debit_spread">Debit spread</option></select></label>
        {select("Symbol","symbol",["QQQ","SPY"])}
        {select("Thesis direction","direction",["unknown","bullish","bearish","range"])}
        {select("Gamma regime","gamma",["unknown","positive","negative"])}
        {select("Chopping around flip?","flipChop",["unknown","yes","no"])}
        {review.strategy==="debit_spread"&&select("Stronger directional confirmation?","strongConfirmation",["unknown","yes","no"])}
      </div>
      <p className="text-xs text-muted-foreground">Paraphrased from your mentor’s supplied checklists. Select GO only with current evidence. In Wingwall’s conservative implementation every row must pass; there is no score-based override.</p>
      <div className="divide-y divide-border">
        {CHECKLISTS[review.strategy].map((c,i)=><div key={c.id} className="grid gap-2 py-4 md:grid-cols-[1fr_140px]">
          <div className="space-y-1"><label htmlFor={`check-${c.id}`} className="text-sm font-medium">{i+1}. {c.label}</label>
            <p className="text-sm text-muted-foreground"><span className="text-foreground">GO:</span> {c.go}</p>
            <p className="text-sm text-muted-foreground"><span className="text-foreground">NO-GO:</span> {c.no}</p>
            <p className="text-xs text-muted-foreground">Check using: {c.source}</p></div>
          <select id={`check-${c.id}`} className={`${field} self-start`} value={review.checks[c.id]??"unknown"} onChange={e=>setReview({...review,checks:{...review.checks,[c.id]:e.target.value as "go"|"no"|"unknown"}})}>
            <option value="unknown">Unknown</option><option value="go">GO</option><option value="no">NO-GO / caution</option></select>
        </div>)}
      </div>
      <label className="grid gap-1 text-sm">Evidence and observations<textarea className={field} rows={3} value={review.evidence} placeholder="Name the sources, observation times, thesis and relevant levels. Do not paste credentials." onChange={e=>setReview({...review,evidence:e.target.value})}/></label>
      <div className="rounded-md bg-muted p-3 text-sm" data-testid="strategy-decision">
        <strong>{assessment.status.replace("_"," ").toUpperCase()}</strong><p>{assessment.message}</p>
        {[...assessment.blockers,...assessment.missing].length>0&&<p className="mt-2 text-muted-foreground">{[...assessment.blockers,...assessment.missing].join(" · ")}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={save.isPending||!reviewSchema.safeParse(review).success} onClick={()=>save.mutate({path:"/api/strategy/reviews",body:review})}>Save review</Button>
        <p className="text-xs text-muted-foreground">Reviews expire after {REVIEW_MINUTES} minutes (Wingwall policy). Re-check sooner if conditions change.</p>
      </div>
      <div className="space-y-2 text-sm">
        {(data?.reviews??[]).map((r:any)=><div key={r.id} className="rounded border border-border p-3">
          {r.symbol} · {r.strategy.replace("_"," ")} · <strong>{r.current?r.assessment.status.replace("_"," ").toUpperCase():"EXPIRED"}</strong>
          <span className="ml-2 text-muted-foreground">Review #{r.id} · {new Date(r.createdAt).toLocaleString()}</span>
        </div>)}
      </div>
    </section>
    <section className={panel}>
      <h3 className="font-semibold">Debit-spread layer planner</h3>
      <p className="text-sm text-muted-foreground">Your mentor’s documents do not specify layering triggers, spacing, count or sizing. Declare your own proposed limits here for review. These are saved scenarios, not orders, positions or an automatic layering system.</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className="grid gap-1 text-sm">Plan symbol<select className={field} value={plan.symbol} onChange={e=>setPlan({...plan,symbol:e.target.value as "QQQ"|"SPY"})}><option>QQQ</option><option>SPY</option></select></label>
        <label className="grid gap-1 text-sm">Plan direction<select className={field} value={plan.direction} onChange={e=>setPlan({...plan,direction:e.target.value as "bullish"|"bearish"})}><option value="bullish">Bullish call spreads</option><option value="bearish">Bearish put spreads</option></select></label>
        <label className="grid gap-1 text-sm">Total risk cap ($)<input className={field} type="number" min="0" value={plan.riskCap||""} onChange={e=>setPlan({...plan,riskCap:Number(e.target.value)})}/></label>
        <label className="grid gap-1 text-sm">Declared layer limit<input className={field} type="number" min="1" max="10" value={plan.maxLayers} onChange={e=>setPlan({...plan,maxLayers:Number(e.target.value)})}/></label>
      </div>
      <label className="grid gap-1 text-sm">Thesis and invalidation<textarea className={field} value={plan.thesis} onChange={e=>setPlan({...plan,thesis:e.target.value})} placeholder="What would confirm the trade, and what invalidates it?"/></label>
      {plan.layers.map((layer,i)=><div key={i} className="space-y-3 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between"><h4 className="text-sm font-semibold">Layer {i+1}</h4>{i>0&&<Button variant="ghost" onClick={()=>setPlan({...plan,layers:plan.layers.filter((_,j)=>j!==i)})}>Remove layer {i+1}</Button>}</div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className="grid gap-1 text-sm">Type<select className={field} aria-label={`Layer ${i+1} type`} value={layer.optionType} onChange={e=>editLayer(i,"optionType",e.target.value)}><option value="call">Call</option><option value="put">Put</option></select></label>
          <label className="grid gap-1 text-sm">Expiration<input className={field} aria-label={`Layer ${i+1} expiration`} type="date" value={layer.expiration} onChange={e=>editLayer(i,"expiration",e.target.value)}/></label>
          {([["longStrike","Long strike"],["shortStrike","Short strike"],["contracts","Contracts"],["debit","Debit / share"],["targetCredit","Target credit / share"],["stopCredit","Stop credit / share"]] as const).map(([key,label])=><label key={key} className="grid gap-1 text-sm">{label}<input className={field} type="number" step={key==="contracts"?"1":"0.01"} aria-label={`Layer ${i+1} ${label}`} value={layer[key]||""} onChange={e=>editLayer(i,key,Number(e.target.value))}/></label>)}
        </div>
        <label className="grid gap-1 text-sm">Entry / add trigger for this layer<textarea className={field} rows={2} aria-label={`Layer ${i+1} trigger`} value={layer.addTrigger} onChange={e=>editLayer(i,"addTrigger",e.target.value)} placeholder="Specific confirmation required before adding; never assume automatic averaging down."/></label>
      </div>)}
      <Button variant="outline" disabled={plan.layers.length>=plan.maxLayers||plan.layers.length>=10} onClick={()=>setPlan({...plan,layers:[...plan.layers,{...emptyLayer(),optionType:plan.direction==="bullish"?"call":"put"}]})}>Add proposed layer</Button>
      {calculation?<div className="rounded-md bg-muted p-3 text-sm space-y-2" data-testid="layer-calculation">
        <p>Combined maximum loss: <strong>${calculation.totalMaxLoss.toFixed(2)}</strong> · Sum of layer maximum profits: ${calculation.totalMaxProfit.toFixed(2)}</p>
        {calculation.layers.map((l,i)=><p key={i}>Layer {i+1}: risk ${l.maxLoss.toFixed(2)} · breakeven {l.breakeven.toFixed(2)} · planned reward/risk {l.plannedRR.toFixed(2)}:1</p>)}
        {calculation.issues.map(v=><p key={v} className="text-destructive">{v}</p>)}
        <p className="text-muted-foreground">{calculation.warning}</p>
      </div>:<p className="text-sm text-muted-foreground">Complete all layer fields and written triggers to calculate risk. Prices are manually entered assumptions, not a live quote feed. QQQ/SPY multiplier: 100.</p>}
      <Button disabled={save.isPending||!calculation?.valid} onClick={()=>save.mutate({path:"/api/strategy/plans",body:plan})}>Save plan only</Button>
      <div className="space-y-3">{(data?.plans??[]).map((p:any)=><details key={p.id} className="rounded border border-border p-3 text-sm">
        <summary className="cursor-pointer">Plan #{p.id} · {p.payload.symbol} · {p.payload.direction} · {p.payload.layers.length} layer(s) · risk ${p.payload.calculation.totalMaxLoss.toFixed(2)}</summary>
        <div className="mt-3 space-y-2"><p>{p.payload.thesis}</p><p>{p.payload.riskWarning}</p>
          <p className="text-muted-foreground">Review at save: {p.payload.reviewStatus}, {p.payload.reviewCurrent?"current then":"missing/expired then"}. Reassess before any entry. Other saved plans are alternatives, not reserved capital.</p>
          {p.payload.layers.map((l:any,i:number)=><p key={i}>Layer {i+1}: {l.optionType} {l.longStrike}/{l.shortStrike}, {l.expiration}, {l.contracts} contract(s), debit {l.debit}. Trigger: {l.addTrigger}</p>)}
          <p className="text-muted-foreground">Plan only. No spread position exists and no worker manages this plan.</p></div>
      </details>)}</div>
    </section>
    {message&&<div role="status" className="sticky bottom-0 rounded-lg border border-border bg-background p-3 text-sm shadow-md">{message}</div>}
  </div>;
}
