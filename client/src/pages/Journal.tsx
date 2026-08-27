import { useMemo, useState } from "react";
import { useFlies, useUpdateFly, useDeleteFly, useSettings, useUpdateSettings, useChain, useFlyPrice } from "@/lib/hooks";
import { computeFlyPricing, computeJournalStats, rMultiple, getMultiplier } from "@/lib/flyMath";
import { fmtUsd, fmtPct, fmtR, todayIso } from "@/lib/format";
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

  const openFlies = useMemo(() => (flies ?? []).filter((f) => f.status === "open"), [flies]);
  const closedFlies = useMemo(() => (flies ?? []).filter((f) => f.status === "closed"), [flies]);
  const stats = useMemo(() => computeJournalStats(closedFlies), [closedFlies]);

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

      <div className="rounded-lg border border-card-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">Settings</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Account balance</Label>
            <Input
              data-testid="input-account-balance"
              type="number"
              defaultValue={settings?.accountBalance ?? 1000}
              onBlur={(e) => updateSettings.mutate({ accountBalance: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Risk per trade (%)</Label>
            <Input
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
