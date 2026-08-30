import { useMemo, useState } from "react";
import {
  useFlies,
  useUpdateFly,
  useDeleteFly,
  useSettings,
  useUpdateSettings,
  useChain,
  useFlyPrice,
  useJournalNotes,
  useCreateJournalNote,
} from "@/lib/hooks";
import { computeFlyPricing, computeJournalStats, rMultiple, getMultiplier } from "@/lib/flyMath";
import { fmtUsd, fmtPct, fmtR, todayIso } from "@/lib/format";
import {
  TAKE_PROFIT_PCT,
  STOP_LOSS_PCT,
  GAMMA_WARNING_DTE,
  WING_BREACH_URGENT_DTE,
  CAPITAL_WARN_PCT,
  CAPITAL_DANGER_PCT,
} from "@shared/thresholds";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { Fly } from "@shared/schema";

export default function Journal() {
  const { data: flies, isLoading } = useFlies();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const { data: journalNotes } = useJournalNotes();
  const createJournalNote = useCreateJournalNote();
  const { toast } = useToast();

  const openFlies = useMemo(() => (flies ?? []).filter((f) => f.status === "open"), [flies]);
  const closedFlies = useMemo(() => (flies ?? []).filter((f) => f.status === "closed"), [flies]);
  const stats = useMemo(() => computeJournalStats(closedFlies), [closedFlies]);

  const handleLogTuningExperiment = async () => {
    const regime = [
      `take_profit=${fmtPct(TAKE_PROFIT_PCT)}`,
      `stop_loss=${fmtPct(STOP_LOSS_PCT)}`,
      `gamma_warning_dte=${GAMMA_WARNING_DTE}`,
      `wing_breach_urgent_dte=${WING_BREACH_URGENT_DTE}`,
      `capital_warn=${fmtPct(CAPITAL_WARN_PCT)}`,
      `capital_danger=${fmtPct(CAPITAL_DANGER_PCT)}`,
    ].join(", ");
    try {
      await createJournalNote.mutateAsync({
        date: todayIso(),
        category: "tuning-experiment",
        text: `Cockpit threshold regime as of today: ${regime}. Logged so future closed trades can be matched to the settings that were active when they were open.`,
      });
      toast({ title: "Tuning experiment logged" });
    } catch (e: any) {
      toast({ title: "Failed to log experiment", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatChip label="Realized P&L" value={fmtUsd(stats.totalPnl, { signed: true })} tone={stats.totalPnl >= 0 ? "positive" : "negative"} />
        <StatChip label="Win rate" value={fmtPct(stats.winRate)} />
        <StatChip
          label="Profit factor"
          value={stats.profitFactor === null ? "—" : stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}
        />
        <StatChip label="Avg R" value={fmtR(stats.avgR)} />
      </div>

      <div className="rounded-lg border border-card-border bg-card">
        <div className="border-b border-card-border px-4 py-3">
          <h2 className="text-sm font-semibold">Open positions ({openFlies.length})</h2>
        </div>
        {isLoading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        ) : openFlies.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No open positions — build one in the Builder tab.</div>
        ) : (
          <FliesTable flies={openFlies} showClose />
        )}
      </div>

      <div className="rounded-lg border border-card-border bg-card">
        <div className="border-b border-card-border px-4 py-3">
          <h2 className="text-sm font-semibold">Closed positions ({closedFlies.length})</h2>
        </div>
        {closedFlies.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No closed trades yet.</div>
        ) : (
          <FliesTable flies={closedFlies} />
        )}
      </div>

      <div className="rounded-lg border border-card-border bg-card">
        <div className="border-b border-card-border px-4 py-3">
          <h2 className="text-sm font-semibold">Threshold review</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            For each closed trade: the peak % of max profit / max loss reached while it was open, whether the
            current take-profit ({fmtPct(TAKE_PROFIT_PCT)}) or stop-loss ({fmtPct(STOP_LOSS_PCT)}) signal ever
            fired, and a discipline read on the exit. Peaks only capture while a browser tab had this dashboard
            open — there's no background job, so this is a lower bound on the true intraday extreme, not a
            guarantee.
          </p>
        </div>
        <ThresholdReview flies={closedFlies} />
      </div>

      <div className="rounded-lg border border-card-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Tuning log</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              A running desk log of threshold changes and experiment notes, so later you can tell which
              regime was active when a given trade was open.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={handleLogTuningExperiment} data-testid="button-log-tuning-experiment">
            Log current regime
          </Button>
        </div>
        {!journalNotes || journalNotes.length === 0 ? (
          <div className="text-sm text-muted-foreground">No log entries yet.</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {journalNotes.map((n) => (
              <li key={n.id} className="rounded-md border border-card-border/60 p-2.5 text-xs">
                <div className="mb-1 flex items-center gap-2 text-muted-foreground">
                  <span className="font-mono">{n.date}</span>
                  <Badge variant="outline" className="text-[10px] capitalize">{n.category.replace("-", " ")}</Badge>
                </div>
                <div>{n.text}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-card-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">Settings</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Account balance</Label>
            <Input
              key={`balance-${settings?.accountBalance ?? "loading"}`}
              data-testid="input-account-balance"
              type="number"
              defaultValue={settings?.accountBalance ?? 1000}
              onBlur={(e) => updateSettings.mutate({ accountBalance: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Risk per trade (%)</Label>
            <Input
              key={`risk-${settings?.riskPerTradePercent ?? "loading"}`}
              data-testid="input-risk-per-trade"
              type="number"
              defaultValue={settings?.riskPerTradePercent ?? 10}
              onBlur={(e) => updateSettings.mutate({ riskPerTradePercent: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Default symbol</Label>
            <Select
              value={settings?.defaultSymbol ?? "QQQ"}
              onValueChange={(v) => updateSettings.mutate({ defaultSymbol: v })}
            >
              <SelectTrigger data-testid="select-default-symbol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="QQQ">QQQ</SelectItem>
                <SelectItem value="SPY">SPY</SelectItem>
                <SelectItem value="MES">MES</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatChip({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  return (
    <div className="rounded-lg border border-card-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${tone === "positive" ? "text-chart-4" : tone === "negative" ? "text-destructive" : "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

// Peak-tracking / discipline review against the CURRENT threshold regime. This is a
// heuristic first pass with zero real closed trades to validate against yet — the
// tolerance bands below (e.g. "near" take-profit) are judgment calls, not derived from
// data. Revisit once there's a real sample of closed trades.
const NEAR_SIGNAL_TOLERANCE = 0.9; // "exited near the signal" = within 90% of the threshold's own magnitude

type Verdict = { label: string; tone: "good" | "warn" | "neutral" };

function computeVerdict(fly: Fly): Verdict {
  const multiplier = getMultiplier(fly.symbol);
  const pnl = ((fly.exitDebit ?? 0) - fly.entryDebit) * multiplier * fly.contracts;
  const finalProfitPct = fly.maxProfit > 0 ? pnl / fly.maxProfit : 0;
  const finalLossPct = fly.maxLoss > 0 ? pnl / fly.maxLoss : 0;

  const hasPeakData = fly.peakProfitPct != null || fly.peakLossPct != null;
  if (!hasPeakData) {
    return { label: "No peak data — opened before tracking began", tone: "neutral" };
  }

  const tpFired = (fly.peakProfitPct ?? -Infinity) >= TAKE_PROFIT_PCT;
  const slFired = (fly.peakLossPct ?? Infinity) <= STOP_LOSS_PCT;

  if (tpFired && pnl >= 0) {
    return finalProfitPct >= TAKE_PROFIT_PCT * NEAR_SIGNAL_TOLERANCE
      ? { label: "Exited at/above take-profit signal — good discipline", tone: "good" }
      : { label: "Take-profit signal fired, but exited after profit decayed — missed exit", tone: "warn" };
  }
  if (slFired) {
    return finalLossPct <= STOP_LOSS_PCT
      ? { label: "Stop-loss signal fired — held past it before exiting", tone: "warn" }
      : { label: "Stop-loss signal fired — exited before it worsened further", tone: "good" };
  }
  return { label: "Neither threshold crossed — closed within normal range", tone: "neutral" };
}

function ThresholdReview({ flies }: { flies: Fly[] }) {
  if (flies.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No closed trades yet — this fills in as positions close. Give it a handful of closes
        (roughly 8-10 for an early read, 15-20+ before the pattern is reliable) before drawing
        conclusions about the {fmtPct(TAKE_PROFIT_PCT)}/{fmtPct(STOP_LOSS_PCT)} regime.
      </div>
    );
  }
  return (
    <div className="max-h-96 overflow-y-auto [overscroll-behavior:contain]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-[1] bg-card">
          <tr className="border-b border-card-border text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Position</th>
            <th className="px-3 py-2 text-right font-medium">Peak % of max profit</th>
            <th className="px-3 py-2 text-right font-medium">Peak % of max loss</th>
            <th className="px-3 py-2 text-right font-medium">Realized outcome</th>
            <th className="px-3 py-2 text-left font-medium">Verdict</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {flies.map((f) => (
            <ThresholdRow key={f.id} fly={f} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ThresholdRow({ fly }: { fly: Fly }) {
  const multiplier = getMultiplier(fly.symbol);
  const pnl = ((fly.exitDebit ?? 0) - fly.entryDebit) * multiplier * fly.contracts;
  const finalPct = pnl >= 0
    ? (fly.maxProfit > 0 ? pnl / fly.maxProfit : 0)
    : (fly.maxLoss > 0 ? pnl / fly.maxLoss : 0);
  const verdict = computeVerdict(fly);
  const toneClass =
    verdict.tone === "good" ? "text-chart-4" : verdict.tone === "warn" ? "text-amber-400" : "text-muted-foreground";

  return (
    <tr className="border-b border-card-border/60 last:border-0">
      <td className="px-3 py-1.5 text-left">
        {fly.symbol} {fly.optionType} {fly.lowerStrike}/{fly.middleStrike}/{fly.upperStrike}
      </td>
      <td className="px-3 py-1.5 text-right">{fly.peakProfitPct != null ? fmtPct(fly.peakProfitPct) : "—"}</td>
      <td className="px-3 py-1.5 text-right">{fly.peakLossPct != null ? fmtPct(fly.peakLossPct) : "—"}</td>
      <td className={`px-3 py-1.5 text-right ${pnl >= 0 ? "text-chart-4" : "text-destructive"}`}>
        {fmtUsd(pnl, { signed: true })} ({fmtPct(finalPct)})
      </td>
      <td className={`px-3 py-1.5 text-left font-sans ${toneClass}`}>{verdict.label}</td>
    </tr>
  );
}

function FliesTable({ flies, showClose }: { flies: Fly[]; showClose?: boolean }) {
  return (
    <div className="max-h-96 overflow-y-auto [overscroll-behavior:contain]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-[1] bg-card">
          <tr className="border-b border-card-border text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Symbol</th>
            <th className="px-3 py-2 text-left font-medium">Type</th>
            <th className="px-3 py-2 text-left font-medium">Expiration</th>
            <th className="px-3 py-2 text-right font-medium">Strikes</th>
            <th className="px-3 py-2 text-right font-medium">Contracts</th>
            <th className="px-3 py-2 text-right font-medium">Entry debit</th>
            <th className="px-3 py-2 text-right font-medium">Max loss</th>
            {showClose ? (
              <th className="px-3 py-2 text-right font-medium">Action</th>
            ) : (
              <>
                <th className="px-3 py-2 text-right font-medium">Exit debit</th>
                <th className="px-3 py-2 text-right font-medium">P&L</th>
                <th className="px-3 py-2 text-right font-medium">R</th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {flies.map((f) => (
            <FlyRow key={f.id} fly={f} showClose={showClose} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlyRow({ fly, showClose }: { fly: Fly; showClose?: boolean }) {
  const { toast } = useToast();
  const updateFly = useUpdateFly();
  const deleteFly = useDeleteFly();
  const [open, setOpen] = useState(false);
  const [exitDebit, setExitDebit] = useState("");

  const isLive = fly.symbol !== "MES";
  const multiplier = getMultiplier(fly.symbol);

  // Live-first pricing (IBKR-then-Cboe) for the "pull current mid" button, sourced
  // from the same endpoint the Builder uses — only fetched while the close dialog is open.
  const flyPriceQuery = useFlyPrice(
    isLive
      ? {
          symbol: fly.symbol,
          optionType: fly.optionType as "call" | "put",
          expiration: fly.expiration,
          lower: fly.lowerStrike,
          middle: fly.middleStrike,
          upper: fly.upperStrike,
          contracts: fly.contracts,
        }
      : null,
    open && isLive
  );
  const livePricing = flyPriceQuery.data ?? null;

  // Fallback: client-side pricing off the Cboe chain, used if the live-price endpoint
  // hasn't returned a usable value yet.
  const { data: chain } = useChain(fly.symbol, open && isLive && livePricing?.midDebit == null);
  const chainPricing = useMemo(() => {
    if (!chain) return null;
    return computeFlyPricing(
      {
        optionType: fly.optionType as "call" | "put",
        lowerStrike: fly.lowerStrike,
        middleStrike: fly.middleStrike,
        upperStrike: fly.upperStrike,
        contracts: fly.contracts,
      },
      chain.options.filter((o) => o.expiration === fly.expiration),
      multiplier
    );
  }, [chain, fly, multiplier]);

  const liveMid = livePricing?.midDebit ?? chainPricing?.midDebit ?? null;
  const priceSource = livePricing?.source === "ibkr" ? "IBKR" : livePricing?.midDebit != null ? "Cboe" : chainPricing ? "Cboe" : null;
  const isPullingMid = open && isLive && liveMid === null && (flyPriceQuery.isLoading || flyPriceQuery.isFetching);

  const pnl = fly.status === "closed" ? ((fly.exitDebit ?? 0) - fly.entryDebit) * multiplier * fly.contracts : null;
  const r = pnl !== null ? rMultiple(pnl, fly.maxLoss) : null;

  const handlePullMid = () => {
    if (liveMid === null) return;
    setExitDebit(liveMid.toFixed(2));
  };

  const handleClose = async () => {
    const ed = parseFloat(exitDebit);
    if (Number.isNaN(ed)) {
      toast({ title: "Enter an exit debit", variant: "destructive" });
      return;
    }
    try {
      await updateFly.mutateAsync({
        id: fly.id,
        patch: { status: "closed", exitDebit: ed, exitDate: todayIso() },
      });
      setOpen(false);
      toast({ title: "Position closed" });
    } catch (e: any) {
      toast({ title: "Failed to close position", description: e.message, variant: "destructive" });
    }
  };

  return (
    <tr className="border-b border-card-border/60 last:border-0">
      <td className="px-3 py-1.5 text-left">{fly.symbol}</td>
      <td className="px-3 py-1.5 text-left capitalize">
        {fly.optionType} {fly.structureType === "bwb" && <Badge variant="outline" className="ml-1 text-[10px]">BWB</Badge>}
      </td>
      <td className="px-3 py-1.5 text-left">{fly.expiration}</td>
      <td className="px-3 py-1.5 text-right">{fly.lowerStrike}/{fly.middleStrike}/{fly.upperStrike}</td>
      <td className="px-3 py-1.5 text-right">{fly.contracts}</td>
      <td className="px-3 py-1.5 text-right">{fmtUsd(fly.entryDebit)}</td>
      <td className="px-3 py-1.5 text-right">{fmtUsd(fly.maxLoss)}</td>
      {showClose ? (
        <td className="px-3 py-1.5 text-right">
          <div className="flex justify-end gap-1.5">
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" data-testid={`button-close-fly-${fly.id}`}>Close</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Close {fly.symbol} {fly.lowerStrike}/{fly.middleStrike}/{fly.upperStrike}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-1.5 py-2">
                  <Label className="text-xs">Exit debit (credit received, per share)</Label>
                  <div className="flex gap-2">
                    <Input
                      data-testid="input-exit-debit"
                      type="number"
                      value={exitDebit}
                      onChange={(e) => setExitDebit(e.target.value)}
                      placeholder="e.g. 4.20"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={!isLive || isPullingMid || liveMid === null}
                      onClick={handlePullMid}
                      data-testid="button-pull-live-mid"
                    >
                      {isPullingMid ? "Loading…" : "Pull current mid"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {!isLive
                      ? "MES has no live feed — enter the exit debit manually."
                      : isPullingMid
                      ? "Fetching live price…"
                      : liveMid !== null
                      ? `Live mid to close (${priceSource}): ${fmtUsd(liveMid)}`
                      : "Strikes not found in the live chain for this expiration — enter manually."}
                  </p>
                </div>
                <DialogFooter>
                  <Button onClick={handleClose} data-testid="button-confirm-close">Confirm close</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button size="sm" variant="ghost" onClick={() => deleteFly.mutate(fly.id)} data-testid={`button-delete-fly-${fly.id}`}>
              Delete
            </Button>
          </div>
        </td>
      ) : (
        <>
          <td className="px-3 py-1.5 text-right">{fmtUsd(fly.exitDebit)}</td>
          <td className={`px-3 py-1.5 text-right ${pnl !== null && pnl >= 0 ? "text-chart-4" : "text-destructive"}`}>{fmtUsd(pnl, { signed: true })}</td>
          <td className="px-3 py-1.5 text-right">{fmtR(r)}</td>
        </>
      )}
    </tr>
  );
}
