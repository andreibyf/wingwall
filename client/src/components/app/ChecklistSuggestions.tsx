import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {Button} from "@/components/ui/button";
import type {ChecklistEvidence} from "@shared/checklist-evidence";
import type {Strategy} from "@shared/strategy-policy";

const stamp=(v:string|null)=>v?`${new Date(v).toLocaleString()} (${v})`:"Not supplied";
export function ChecklistSuggestions({symbol,strategy,drafts}:{symbol:string;strategy:Strategy;drafts:any[]}){
  const [draftId,setDraftId]=useState("");
  const url=`/api/strategy/evidence?symbol=${symbol}&strategy=${strategy}${draftId?`&draftId=${draftId}`:""}`;
  const {data,error,isFetching,refetch}=useQuery<ChecklistEvidence>({queryKey:[url],refetchInterval:60_000,staleTime:30_000,retry:false});
  const matching=drafts.filter(d=>d.payload.symbol===symbol&&[strategy,"wait"].includes(d.payload.strategy));
  return <section className="rounded-md border border-border bg-muted/30 p-3 space-y-3" aria-label="Suggested checklist evidence">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold text-sm">Suggested values · not approvals</h4>
      <Button type="button" variant="outline" size="sm" disabled={isFetching} onClick={()=>refetch()}>{isFetching?"Loading evidence…":"Refresh suggestions"}</Button></div>
    <label className="grid gap-1 text-sm">Reference draft
      <select aria-label="Evidence reference draft" className="w-full min-w-0 rounded border border-input bg-background p-2" value={draftId} onChange={e=>setDraftId(e.target.value)}>
        <option value="">None: show available market context</option>
        {matching.map(d=><option key={d.id} value={d.id}>#{d.id} · {d.payload.title}</option>)}
      </select>
    </label>
    <p className="text-xs text-muted-foreground">Read-only suggestions. Your checklist answers stay unchanged. Draft times identify proposals, not market observations. Refresh reads cached Gexbot data; use Campaign to refresh that provider.</p>
    {error?<p role="alert" className="text-sm text-destructive">Suggestions unavailable. No previous response is shown as current. Check the connection and retry.</p>:data&&<>
      <p className="text-xs text-muted-foreground break-words">Collected: {stamp(data.generatedAt)}. Times below include UTC for audit.</p>
      <div className="divide-y divide-border">{data.items.map(item=><details key={item.id} className="py-2 text-sm" open={["gamma","thesis"].includes(item.id)}>
        <summary className="cursor-pointer break-words"><span className="font-medium">{item.label}</span> · {item.status.toUpperCase()}<span className="block mt-1">{item.value}</span></summary>
        <div className="mt-2 space-y-1 text-xs text-muted-foreground break-words">
          <p>{item.detail}</p><p>Source: {item.source}</p>
          <p>{item.status==="proposal"?"Proposal recorded":"Source observed"}: {stamp(item.observedAt)}</p>
          <p>Retrieved: {stamp(item.retrievedAt)}</p>
        </div>
      </details>)}</div>
    </>}
  </section>;
}
