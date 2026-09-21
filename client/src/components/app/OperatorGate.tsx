import { useEffect, useState, type ReactNode } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function OperatorGate({children}:{children:ReactNode}) {
  const [status,setStatus]=useState<{configured:boolean;authenticated:boolean}|null>(null);
  const [password,setPassword]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const check=()=>apiRequest("GET","/api/auth/status").then(r=>r.json()).then(setStatus).catch(()=>setError("Unable to reach Wingwall. Please reload."));
  useEffect(()=>{void check();},[]);
  useEffect(()=>{
    const expired=()=>{setStatus(s=>s?{...s,authenticated:false}:s);setError("Your session expired. Sign in again.");};
    window.addEventListener("wingwall-auth-expired",expired);
    return ()=>window.removeEventListener("wingwall-auth-expired",expired);
  },[]);
  if(status?.authenticated) return <>{children}</>;
  return <main className="min-h-screen flex items-center justify-center bg-background p-6">
    <form className="w-full max-w-sm rounded-lg border border-border p-6 space-y-4" onSubmit={async e=>{
      e.preventDefault();setBusy(true);setError("");
      try {await apiRequest("POST","/api/auth/login",{password});setPassword("");await check();}
      catch(err){setError(err instanceof Error?err.message:"Sign-in failed");}
      finally{setBusy(false);}
    }}>
      <h1 className="text-xl font-semibold">Wingwall operator sign-in</h1>
      <p className="text-sm text-muted-foreground">Private paper-trading desk. No broker orders are placed.</p>
      {!status ? <p role="status">Checking access…</p> : !status.configured ?
        <p role="alert">Set WINGWALL_OPERATOR_PASSWORD to a passphrase of at least 16 characters in Render, then reload. Access remains locked until configured.</p> :
        <><label htmlFor="operator-password" className="text-sm">Operator passphrase</label>
          <Input id="operator-password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/>
          <Button className="w-full" disabled={busy}>{busy?"Signing in…":"Sign in"}</Button></>}
      {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
    </form>
  </main>;
}
