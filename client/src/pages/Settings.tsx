import { useEffect, useMemo, useState } from "react";
import { useSettings, useUpdateSettings, useFlies } from "@/lib/hooks";
import { apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Loader2, ShieldCheck, Play } from "lucide-react";
import { resolveExitPolicy } from "@shared/exit-policy";
import { useQuery } from "@tanstack/react-query";

/**
 * Everything the automation reads at runtime, editable. Nothing on this page is cosmetic:
 * each field is consumed by the scheduled threshold watch, the proposal engine, or the
 * autonomous entry run, so the copy explains the consequence of a change rather than just
 * naming the field.
 */

type Draft = {
  accountBalance: string;
  riskPerTradePercent: string;
  defaultSymbol: string;
  takeProfitMode: string;
  takeProfitValue: string;
  stopLossPctOfMaxLoss: string;
  targetDebitToWidth: string;
  maxDebitToWidth: string;
};

/** Pull the readable part out of apiRequest's `"400: {json}"` error string. */
function readableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const brace = raw.indexOf("{");
  if (brace === -1) return raw;
  try {
    const body = JSON.parse(raw.slice(brace));
    if (Array.isArray(body.fieldErrors) && body.fieldErrors.length) {
      return body.fieldErrors.map((f: any) => f.message).join(" ");
    }
    return body.message ?? raw;
  } catch {
    return raw;
  }
}

export default function Settings() {
  const { toast } = useToast();
  const { data: settings } = useSettings();
  const { data: flies } = useFlies();
  const updateSettings = useUpdateSettings();
  const {data:automation}=useQuery<any>({queryKey:["/api/automation/status"],refetchInterval:30_000,staleTime:0});

  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (!settings || draft) return;
    setDraft({
      accountBalance: String(settings.accountBalance ?? ""),
      riskPerTradePercent: String(settings.riskPerTradePercent ?? ""),
      defaultSymbol: settings.defaultSymbol ?? "QQQ",
      takeProfitMode: settings.takeProfitMode ?? "multipleOfDebit",
      takeProfitValue: String(settings.takeProfitValue ?? ""),
      stopLossPctOfMaxLoss: String(settings.stopLossPctOfMaxLoss ?? ""),
      targetDebitToWidth: String(settings.targetDebitToWidth ?? ""),
      maxDebitToWidth: String(settings.maxDebitToWidth ?? ""),
    });
  }, [settings, draft]);

  const set = (k: keyof Draft, v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  const openFlies = (flies ?? []).filter((f: any) => f.status === "open");

  // Previewed live from the draft, using the same resolver the server uses, so the effect of
  // an edit is visible before it is saved rather than discovered by an automated exit.
  const policyPreview = useMemo(() => {
    if (!draft) return null;
    const tpv = Number(draft.takeProfitValue);
    const sl = Number(draft.stopLossPctOfMaxLoss);
    if (!Number.isFinite(tpv) || !Number.isFinite(sl)) return null;
    try {
      return resolveExitPolicy({
        takeProfitMode: draft.takeProfitMode as any,
        takeProfitValue: tpv,
        stopLossPctOfMaxLoss: sl,
      });
    } catch {
      return null;
    }
  }, [draft]);

  const riskDollars = useMemo(() => {
    if (!draft) return null;
    const b = Number(draft.accountBalance);
    const p = Number(draft.riskPerTradePercent);
    if (!Number.isFinite(b) || !Number.isFinite(p)) return null;
    return (b * p) / 100;
  }, [draft]);

  async function save() {
    if (!draft) return;
    const patch = {
      accountBalance: Number(draft.accountBalance),
      riskPerTradePercent: Number(draft.riskPerTradePercent),
      defaultSymbol: draft.defaultSymbol,
      takeProfitMode: draft.takeProfitMode,
      takeProfitValue: Number(draft.takeProfitValue),
      stopLossPctOfMaxLoss: Number(draft.stopLossPctOfMaxLoss),
      targetDebitToWidth: Number(draft.targetDebitToWidth),
      maxDebitToWidth: Number(draft.maxDebitToWidth),
    };
    try {
      await updateSettings.mutateAsync(patch as any);
      toast({
        title: "Settings saved",
        description: "The scheduled watch and the proposal engine read these on their next run.",
      });
    } catch (err) {
      // The server names the offending field; surfacing it verbatim beats "failed to save".
      toast({ title: "Rejected", description: readableError(err), variant: "destructive" });
    }
  }

  async function toggleAutoTrade(next: boolean) {
    try {
      await updateSettings.mutateAsync({ autoTradeEnabled: next } as any);
      toast({
        title: next ? "Autonomous entry armed" : "Autonomous entry off",
        description: next
          ? "The scheduled run may now open one position per week without asking."
          : "New entries are disabled. Exit monitoring is independent.",
      });
    } catch (err) {
      toast({ title: "Rejected", description: readableError(err), variant: "destructive" });
    }
  }

  async function runPreview() {
    setPreviewing(true);
    setPreview(null);
    try {
      const res = await apiRequest("GET", "/api/auto-trade/preview");
      setPreview(await res.json());
    } catch (err) {
      toast({ title: "Preview failed", description: readableError(err), variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  }

  if (!draft || !settings) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
      </div>
    );
  }

  const armed = settings.autoTradeEnabled === true;
  const p = preview;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        These settings govern simulated paper positions only. Execution requires a healthy
        worker, paper-write mode, fresh quotes, and a valid exchange session.
      </p>
      <section className="rounded-lg border border-border p-4 space-y-2" data-testid="automation-readiness">
        <h2 className="text-sm font-semibold">Paper-worker readiness</h2>
        <p className="text-sm">Mode: {automation?.mode ?? "checking"} · Heartbeat: {automation?.heartbeatFresh?"current":"missing or stale"}</p>
        <p className="text-sm">Entries: {automation?.entryArmed?"armed":"off"} · Exit worker: {automation?.exitsEnabled?"enabled":"disabled"}</p>
        <p className="text-xs text-muted-foreground">Observation mode evaluates proposals even with entry off, but never opens or closes positions. Paper-write mode requires quotes no more than two minutes old. Entry window: Monday–Wednesday, 9:45–10:30 AM Eastern, excluding holidays.</p>
        {automation && !automation.healthy && <p role="alert" className="text-sm text-destructive">Worker is not healthy. Do not rely on unattended protection.</p>}
        {automation?.runs?.slice(0,3).map((r:any)=><div key={r.run_key} className="text-xs break-words">
          {new Date(r.started_at).toLocaleString()}: {r.outcome}
          {r.detail?.entry && <p>Entry: {r.detail.entry.outcome}. {r.detail.entry.detail}</p>}
          {r.detail?.alerts?.length>0 && <p role="alert">{r.detail.alerts.join(" · ")}</p>}
          {r.detail?.alert && <p role="alert">{r.detail.alert}</p>}
        </div>)}
        <Button variant="outline" size="sm" onClick={async()=>{await apiRequest("POST","/api/auth/logout");window.location.reload();}}>Sign out</Button>
      </section>

      {/* ---- Exits ---- */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">Exit policy</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          In paper-write mode, the worker closes a simulated position when a threshold fires.
          In observation mode it records the decision without closing.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tp-mode">Take-profit measured as</Label>
            <Select value={draft.takeProfitMode} onValueChange={(v) => set("takeProfitMode", v)}>
              <SelectTrigger id="tp-mode" data-testid="select-take-profit-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="multipleOfDebit">Multiple of the entry debit</SelectItem>
                <SelectItem value="pctOfMaxProfit">Percent of max profit</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tp-value">
              {draft.takeProfitMode === "multipleOfDebit" ? "Multiple (2 = double your debit)" : "Fraction of max profit (0.25 = 25%)"}
            </Label>
            <Input
              id="tp-value"
              data-testid="input-take-profit-value"
              value={draft.takeProfitValue}
              onChange={(e) => set("takeProfitValue", e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="sl-value">Stop, as a fraction of max loss (negative)</Label>
            <Input
              id="sl-value"
              data-testid="input-stop-loss-pct"
              value={draft.stopLossPctOfMaxLoss}
              onChange={(e) => set("stopLossPctOfMaxLoss", e.target.value)}
              inputMode="decimal"
            />
            <span className="text-xs text-muted-foreground">
              Must be negative. It is compared against a signed loss fraction, so a positive value
              could never trigger and the stop would silently not exist.
            </span>
          </div>
        </div>

        {policyPreview && (
          <div className="mt-4 rounded-md bg-muted/50 p-3 text-xs" data-testid="text-policy-preview">
            <div className="font-medium">In force after saving</div>
            {/* These are sentence fragments by design, so they need their subject here. */}
            <div className="mt-1 text-muted-foreground">Take-profit {policyPreview.describeTakeProfit}.</div>
            <div className="text-muted-foreground">Stop {policyPreview.describeStopLoss}.</div>
          </div>
        )}

        {/* Percent-of-max-profit was the original rule and it was unreachable on every trade
            this book has taken, so switching back to it earns an explicit warning rather
            than a silent accept. */}
        {draft.takeProfitMode === "pctOfMaxProfit" && (
          <div className="mt-3 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            <span>
              On the three trades closed so far, a percent-of-max-profit target needed 4.2x to 5.4x
              the entry debit to trigger, while the best mark any of them ever reached was 9.4% of
              max profit. Under this mode the stop can fire and the target cannot.
            </span>
          </div>
        )}
      </section>

      {/* ---- Sizing ---- */}
      <section className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">Risk and structure</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="balance">Account balance</Label>
            <Input
              id="balance"
              data-testid="input-account-balance"
              value={draft.accountBalance}
              onChange={(e) => set("accountBalance", e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="risk-pct">Risk per trade (%)</Label>
            <Input
              id="risk-pct"
              data-testid="input-risk-percent"
              value={draft.riskPerTradePercent}
              onChange={(e) => set("riskPerTradePercent", e.target.value)}
              inputMode="decimal"
            />
            {riskDollars !== null && (
              <span className="text-xs text-muted-foreground" data-testid="text-risk-dollars">
                Caps a new position at ${riskDollars.toFixed(2)} of max loss.
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="symbol">Default symbol</Label>
            <Select value={draft.defaultSymbol} onValueChange={(v) => set("defaultSymbol", v)}>
              <SelectTrigger id="symbol" data-testid="select-default-symbol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="QQQ">QQQ</SelectItem>
                <SelectItem value="SPY">SPY</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="target-dw">Target debit ÷ wing width</Label>
            <Input
              id="target-dw"
              data-testid="input-target-debit-width"
              value={draft.targetDebitToWidth}
              onChange={(e) => set("targetDebitToWidth", e.target.value)}
              inputMode="decimal"
            />
            <span className="text-xs text-muted-foreground">
              What you aim to pay per point of wing. The trades in this book filled between 0.054
              and 0.072.
            </span>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="max-dw">Maximum debit ÷ wing width</Label>
            <Input
              id="max-dw"
              data-testid="input-max-debit-width"
              value={draft.maxDebitToWidth}
              onChange={(e) => set("maxDebitToWidth", e.target.value)}
              inputMode="decimal"
            />
            <span className="text-xs text-muted-foreground">
              A hard ceiling. Any width priced above this is discarded however attractive it looks.
            </span>
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={updateSettings.isPending} data-testid="button-save-settings">
          {updateSettings.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save settings
        </Button>
        <span className="text-xs text-muted-foreground">
          Invalid values are rejected with the reason, not silently stored.
        </span>
      </div>

      {/* ---- Autonomous entry ---- */}
      <section className="rounded-lg border border-border p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="h-4 w-4" /> Autonomous entry
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              When armed, the scheduled run may open one position on the keyed branch without
              asking. Strikes and size are chosen in code; a model reviews the finished structure
              and can only approve or decline it. Anything unexpected — no keyed wall for the
              current week, a position already open, an unreadable review — results in no trade.
            </p>
          </div>
          <Switch
            checked={armed}
            onCheckedChange={toggleAutoTrade}
            data-testid="switch-auto-trade"
            aria-label="Arm autonomous entry"
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant={armed ? "default" : "secondary"} data-testid="badge-auto-trade-state">
            {armed ? "Armed" : "Off"}
          </Badge>
          {openFlies.length > 0 && (
            <Badge variant="outline">
              {openFlies.length} open — entry will not stack
            </Badge>
          )}
        </div>

        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={runPreview} disabled={previewing} data-testid="button-preview-auto-trade">
            {previewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            Preview what it would do
          </Button>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Runs the full engine against the live chain and writes nothing, whether or not it is
            armed.
          </p>
        </div>

        {p && (
          <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-xs" data-testid="text-auto-trade-preview">
            <div className="flex flex-wrap items-center gap-2">
              {/* The server's outcome for an approved dry run is still "entered", which is
                  accurate about the decision but misleading on a preview that opened
                  nothing. Relabelled here rather than in the API, where callers depend on
                  the value. */}
              <Badge variant={p.outcome === "entered" ? "default" : "secondary"}>
                {p.outcome === "entered" && p.dryRun ? "would enter" : p.outcome.replace(/_/g, " ")}
              </Badge>
              {p.branch && <Badge variant="outline">branch: {p.branch}</Badge>}
            </div>
            <div className="mt-2 text-muted-foreground">{p.detail}</div>

            {p.proposal?.viable && (
              <div className="mt-3 space-y-1.5">
                <div className="font-medium text-foreground">
                  {p.proposal.optionType} {p.proposal.lowerStrike}/{p.proposal.middleStrike}/
                  {p.proposal.upperStrike} · exp {p.proposal.expiration} · {p.proposal.contracts}x @ $
                  {p.proposal.entryDebit}
                </div>
                <div className="text-muted-foreground">
                  Risk ${p.proposal.maxLoss} · max profit ${p.proposal.maxProfit} ·{" "}
                  {p.proposal.rewardToRisk}:1
                </div>
                {p.proposal.thresholds?.takeProfitIsUnreachable && (
                  <div className="flex gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
                    <span>{p.proposal.thresholds.unreachableReason}</span>
                  </div>
                )}
                <div className="text-muted-foreground">{p.proposal.bodyRationale}</div>
                <div className="text-muted-foreground">{p.proposal.wingRationale}</div>
                <div className="text-muted-foreground">{p.proposal.sizingRationale}</div>
              </div>
            )}

            {p.verdict && (
              <div className="mt-3 border-t border-border pt-2">
                <div className="font-medium text-foreground">
                  Risk gate: {p.verdict.approved ? "approved" : "declined"} ({p.verdict.confidence})
                </div>
                <div className="mt-1 text-muted-foreground">{p.verdict.rationale}</div>
                {p.verdict.parseError && (
                  <div className="mt-1 text-amber-500">Gate failure: {p.verdict.parseError}</div>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
