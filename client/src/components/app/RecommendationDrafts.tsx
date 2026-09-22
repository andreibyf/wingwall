import {useState} from "react";
import {useQuery,useMutation} from "@tanstack/react-query";
import {apiRequest,queryClient} from "@/lib/queryClient";
import {Button} from "@/components/ui/button";
import {recommendationDraftSchema,type RecommendationDraft} from "@shared/recommendation-draft";

type Row={id:number;payload:RecommendationDraft;version:number;createdAt:string;originalPayload:RecommendationDraft};
const field="w-full rounded-md border border-input bg-background p-2 text-sm";
export function RecommendationDrafts(){
  const {data,error,isLoading}=useQuery<Row[]>({queryKey:["/api/copilot/drafts"]});
  const [selected,setSelected]=useState<Row|null>(null);
  const [notice,setNotice]=useState("");
  const save=useMutation({
    mutationFn:async(row:Row)=>(await apiRequest("PATCH",`/api/copilot/drafts/${row.id}`,{payload:row.payload,version:row.version})).json(),
    onSuccess:r=>{setSelected(old=>old?{...old,...r}:null);setNotice("Edits saved. No execution or checklist approval.");queryClient.invalidateQueries({queryKey:["/api/copilot/drafts"]});},
    onError:(e:Error)=>setNotice(e.message),
  });
  const edit=(key:keyof RecommendationDraft,value:unknown)=>setSelected(old=>old?{...old,payload:{...old.payload,[key]:value}}:null);
  const payload=selected?.payload;
  return <section className="rounded-lg border border-border bg-card p-4 md:p-5 space-y-4" id="recommendation-drafts">
    <div className="space-y-2"><h3 className="font-semibold">Recommendation drafts</h3>
      <p className="text-sm text-muted-foreground">Ask Copilot to “plug in a recommendation draft for me.” It populates a saved, editable setup here, even when the right answer is wait. These drafts never feed execution workers or approve checklist evidence.</p>
      <p className="text-xs text-muted-foreground">Draft only · not armed · prices and evidence must be rechecked before use. Saved times are not quote timestamps.</p></div>
    {isLoading&&<p role="status">Loading drafts…</p>}
    {error&&<p role="alert" className="text-sm text-destructive">Could not load drafts. Sign in or refresh to retry.</p>}
    {data?.length===0&&<p className="text-sm text-muted-foreground">No saved drafts yet. Open Copilot to prepare one.</p>}
    <div className="flex flex-wrap gap-2">{data?.map(row=><Button key={row.id} className="h-auto min-h-9 max-w-full whitespace-normal break-words text-left" variant={selected?.id===row.id?"default":"outline"} disabled={save.isPending} onClick={()=>{setSelected(structuredClone(row));setNotice("");}}>
      #{row.id} {row.payload.symbol}: {row.payload.title}
    </Button>)}</div>
    {selected&&payload&&<div className="space-y-4" data-testid="recommendation-editor">
      <p className="text-xs text-muted-foreground">Draft #{selected.id} · created {new Date(selected.createdAt).toLocaleString()} · revision {selected.version}. Selecting another draft or reloading discards unsaved edits.</p>
      <label className="grid gap-1 text-sm">Draft title<input className={field} value={payload.title} onChange={e=>edit("title",e.target.value)}/></label>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {([["symbol",["QQQ","SPY","MES"]],["strategy",["butterfly","debit_spread","wait"]],["direction",["bullish","bearish","range","unknown"]]] as const).map(([key,options])=><label key={key} className="grid gap-1 text-sm">Draft {key}<select className={field} value={payload[key]} onChange={e=>edit(key,e.target.value)}>{options.map(v=><option key={v} value={v}>{v.replaceAll("_"," ")}</option>)}</select></label>)}
      </div>
      {(["thesis","entryCondition","exitPlan","invalidation"] as const).map(key=><label key={key} className="grid gap-1 text-sm">{({thesis:"Thesis and proposed assumptions",entryCondition:"Entry / layer conditions",exitPlan:"Exit plan",invalidation:"Invalidation"})[key]}<textarea className={field} rows={2} value={payload[key]} onChange={e=>edit(key,e.target.value)}/></label>)}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["riskCap","suggestedDebit","targetCredit","stopCredit"] as const).map(key=><label key={key} className="grid gap-1 text-sm">{({riskCap:"Proposed risk cap ($)",suggestedDebit:"Proposed debit / share",targetCredit:"Target credit / share",stopCredit:"Stop credit / share"})[key]}<input className={field} type="number" min="0" step="0.01" placeholder="Unknown" value={payload[key]??""} onChange={e=>edit(key,e.target.value===""?null:Number(e.target.value))}/></label>)}
      </div>
      <p className="text-xs text-muted-foreground">Leg ratios describe a proposed structure, not an order quantity. Layer instructions are planning text, not executable triggers.</p>
      {payload.legs.map((leg,i)=><fieldset key={i} className="rounded border border-border p-3 grid grid-cols-2 md:grid-cols-5 gap-3"><legend className="text-sm">Proposed leg {i+1}</legend>
        {(["side","optionType","strike","expiration","ratio"] as const).map(key=>{
          const update=(value:unknown)=>edit("legs",payload.legs.map((l,j)=>i===j?{...l,[key]:value}:l));
          return <label key={key} className="grid gap-1 text-sm">{key}
            {key==="side"||key==="optionType"?<select aria-label={`Leg ${i+1} ${key}`} className={field} value={leg[key]} onChange={e=>update(e.target.value)}>{(key==="side"?["buy","sell"]:["call","put"]).map(v=><option key={v}>{v}</option>)}</select>:
              <input aria-label={`Leg ${i+1} ${key}`} className={field} type={key==="expiration"?"date":"number"} step={key==="ratio"?"1":"0.01"} value={leg[key]??""} onChange={e=>update(key==="expiration"?(e.target.value||null):e.target.value===""?null:Number(e.target.value))}/>}
          </label>;
        })}
        <Button variant="ghost" onClick={()=>edit("legs",payload.legs.filter((_,j)=>i!==j))}>Remove leg {i+1}</Button>
      </fieldset>)}
      <Button variant="outline" disabled={payload.legs.length>=30} onClick={()=>edit("legs",[...payload.legs,{side:"buy",optionType:"call",strike:null,expiration:null,ratio:1}])}>Add proposed leg</Button>
      {(["evidence","missingEvidence"] as const).map(key=><label key={key} className="grid gap-1 text-sm">{key==="evidence"?"Evidence and source times (one per line)":"Missing / stale evidence (one per line)"}<textarea className={field} rows={3} value={payload[key].join("\n")} onChange={e=>edit(key,e.target.value.split("\n"))}/></label>)}
      <div className="flex flex-wrap gap-3">
        <Button disabled={save.isPending||!recommendationDraftSchema.safeParse(payload).success} onClick={()=>save.mutate(selected)}>Save draft edits</Button>
        <Button variant="outline" disabled={save.isPending} onClick={()=>{const row=data?.find(r=>r.id===selected.id);if(row)setSelected(structuredClone(row));setNotice("Unsaved edits discarded.");}}>Discard unsaved edits</Button>
      </div>
      <details className="text-sm"><summary className="cursor-pointer">Original agent recommendation (audit copy)</summary><pre className="whitespace-pre-wrap break-words text-xs mt-2">{JSON.stringify(selected.originalPayload,null,2)}</pre></details>
    </div>}
    {notice&&<p role="status" className="text-sm">{notice}</p>}
  </section>;
}
