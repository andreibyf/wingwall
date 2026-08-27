import { useMemo, useState } from "react";
import { useChain, useFlies, useCreateFly } from "@/lib/hooks";
import { computeFlyPricing, deriveFlyEconomics } from "@/lib/flyMath";
import { fmtUsd, fmtNum, todayIso } from "@/lib/format";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

const SYMBOLS = [
  { value: "QQQ", label: "QQQ", live: true },
  { value: "SPY", label: "SPY", live: true },
  { value: "MES", label: "MES", live: false },
];

export default function Builder() {
  const { toast } = useToast();
  const [symbol, setSymbol] = useState("QQQ");
  const [optionType, setOptionType] = useState<"call" | "put">("call");
  const [expiration, setExpiration] = useState<string>("");
  const [lowerStrike, setLowerStrike] = useState<string>("");
  const [middleStrike, setMiddleStrike] = useState<string>("");
  const [upperStrike, setUpperStrike] = useState<string>("");
  const [contracts, setContracts] = useState<string>("1");
  const [manualExpiration, setManualExpiration] = useState<string>("");
  const [manualDebit, setManualDebit] = useState<string>("");

  const isLive = SYMBOLS.find((s) => s.value === symbol)?.live ?? false;
  const { data: chain, isLoading: chainLoading, error: chainError } = useChain(symbol, isLive);
  const { data: flies } = useFlies();
  const createFly = useCreateFly();

  const expirations = chain?.expirations ?? [];
  const activeExpiration = expiration || expirations[0] || "";

  const strikesForExpiration = useMemo(() => {
    if (!chain) return [];
    return Array.from(
      new Set(
        chain.options
          .filter((o) => o.expiration === activeExpiration && o.type === optionType)
          .map((o) => o.strike)
      )
    ).sort((a, b) => a - b);
  }, [chain, activeExpiration, optionType]);

  const legs = {
    optionType,
    lowerStrike: parseFloat(lowerStrike),
    middleStrike: parseFloat(middleStrike),
    upperStrike: parseFloat(upperStrike),
    contracts: parseInt(contracts, 10) || 1,
  };

  const legsComplete =
    !Number.isNaN(legs.lowerStrike) &&
    !Number.isNaN(legs.middleStrike) &&
    !Number.isNaN(legs.upperStrike) &&
    legs.lowerStrike < legs.middleStrike &&
    legs.middleStrike < legs.upperStrike;

  const pricing =
    isLive && legsComplete && chain
      ? computeFlyPricing(legs, chain.options.filter((o) => o.expiration === activeExpiration))
      : null;

  const parsedManualDebit = parseFloat(manualDebit);
  const manualPricing =
    !isLive && legsComplete && !Number.isNaN(parsedManualDebit)
      ? deriveFlyEconomics(legs.lowerStrike, legs.middleStrike, legs.upperStrike, legs.contracts, parsedManualDebit)
      : null;

  // Blocked strikes: strikes already committed by open positions in this symbol+expiration.
  const effectiveExpiration = isLive ? activeExpiration : manualExpiration;
  const blockedStrikes = useMemo(() => {
    if (!flies) return new Set<number>();
    const set = new Set<number>();
    flies
      .filter((f) => f.status === "open" && f.symbol === symbol && f.expiration === effectiveExpiration)
      .forEach((f) => {
        set.add(f.lowerStrike);
        set.add(f.middleStrike);
        set.add(f.upperStrike);
      });
    return set;
  }, [flies, symbol, effectiveExpiration]);

  const collision =
    legsComplete &&
    (blockedStrikes.has(legs.lowerStrike) ||
      blockedStrikes.has(legs.middleStrike) ||
      blockedStrikes.has(legs.upperStrike));

  const canLog = isLive
    ? !!pricing && pricing.midDebit !== null
    : !!manualPricing && manualExpiration.trim().length > 0;

  const handleLog = async () => {
    if (!canLog) return;
    try {
      if (isLive && pricing && pricing.midDebit !== null) {
        await createFly.mutateAsync({
          symbol,
          optionType,
          structureType: pricing.isBrokenWing ? "bwb" : "symmetric",
          expiration: activeExpiration,
          lowerStrike: legs.lowerStrike,
          middleStrike: legs.middleStrike,
          upperStrike: legs.upperStrike,
          contracts: legs.contracts,
          entryDebit: Number(pricing.midDebit.toFixed(4)),
          entryDate: todayIso(),
          status: "open",
          exitDebit: null,
          exitDate: null,
          maxLoss: Math.round(pricing.maxLossMid ?? 0),
          maxProfit: Math.round(pricing.maxProfit ?? 0),
          campaignWallId: null,
          notes: null,
        });
        toast({ title: "Fly logged", description: `${symbol} ${activeExpiration} ${legs.lowerStrike}/${legs.middleStrike}/${legs.upperStrike} added to journal.` });
      } else if (manualPricing) {
        await createFly.mutateAsync({
          symbol,
          optionType,
          structureType: manualPricing.isBrokenWing ? "bwb" : "symmetric",
          expiration: manualExpiration.trim(),
          lowerStrike: legs.lowerStrike,
          middleStrike: legs.middleStrike,
          upperStrike: legs.upperStrike,
          contracts: legs.contracts,
          entryDebit: Number(parsedManualDebit.toFixed(4)),
          entryDate: todayIso(),
          status: "open",
          exitDebit: null,
          exitDate: null,
          maxLoss: Math.round(manualPricing.maxLoss),
          maxProfit: Math.round(manualPricing.maxProfit),
          campaignWallId: null,
          notes: null,
        });
        toast({ title: "Fly logged", description: `${symbol} ${manualExpiration.trim()} ${legs.lowerStrike}/${legs.middleStrike}/${legs.upperStrike} added to journal.` });
      }
    } catch (e: any) {
      toast({ title: "Failed to log fly", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
        {/* Fly construction panel */}
        <div className="flex flex-col gap-4 rounded-lg border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">Construct fly</h2>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Symbol</Label>
              <Select value={symbol} onValueChange={(v) => { setSymbol(v); setExpiration(""); }}>
                <SelectTrigger data-testid="select-symbol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SYMBOLS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label} {!s.live && "(no live feed)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Option type</Label>
              <Select value={optionType} onValueChange={(v) => setOptionType(v as "call" | "put")}>
                <SelectTrigger data-testid="select-option-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="call">Call</SelectItem>
                  <SelectItem value="put">Put</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {!isLive && (
            <>
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                MES has no free public options-chain feed (CME product, not Cboe-listed). Enter strikes and pricing manually below.
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Expiration</Label>
                <Input
                  data-testid="input-manual-expiration"
                  type="date"
                  value={manualExpiration}
                  onChange={(e) => setManualExpiration(e.target.value)}
                />
              </div>
            </>
          )}

          {isLive && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Expiration</Label>
              <Select value={activeExpiration} onValueChange={setExpiration} disabled={chainLoading || expirations.length === 0}>
                <SelectTrigger data-testid="select-expiration">
                  <SelectValue placeholder={chainLoading ? "Loading chain…" : "Select expiration"} />
                </SelectTrigger>
                <SelectContent>
                  {expirations.map((e) => (
                    <SelectItem key={e} value={e}>{e}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {chainError && (
                <span className="text-xs text-destructive">Chain fetch failed — try again shortly.</span>
              )}
              {chain && (
                <span className="text-xs text-muted-foreground">
                  Spot {fmtUsd(chain.spot)} · updated {new Date(chain.timestamp).toLocaleTimeString()}
                </span>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Lower</Label>
              <Input
                data-testid="input-lower-strike"
                type="number"
                value={lowerStrike}
                onChange={(e) => setLowerStrike(e.target.value)}
                placeholder="e.g. 700"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Body</Label>
              <Input
                data-testid="input-middle-strike"
                type="number"
                value={middleStrike}
                onChange={(e) => setMiddleStrike(e.target.value)}
                placeholder="e.g. 715"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Upper</Label>
              <Input
                data-testid="input-upper-strike"
                type="number"
                value={upperStrike}
                onChange={(e) => setUpperStrike(e.target.value)}
                placeholder="e.g. 730"
              />
            </div>
          </div>

          {isLive && strikesForExpiration.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Available strikes: {strikesForExpiration.slice(0, 8).map((s) => fmtNum(s, 0)).join(", ")}
              {strikesForExpiration.length > 8 ? "…" : ""}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Contracts</Label>
            <Input
              data-testid="input-contracts"
              type="number"
              min={1}
              value={contracts}
              onChange={(e) => setContracts(e.target.value)}
            />
          </div>

          {!isLive && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Entry debit (per share, manual)</Label>
              <Input
                data-testid="input-manual-debit"
                type="number"
                step="0.01"
                value={manualDebit}
                onChange={(e) => setManualDebit(e.target.value)}
                placeholder="e.g. 12.50"
              />
            </div>
          )}

          {collision && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="warning-blocked-strikes">
              One or more strikes are already committed by an open position in this symbol/expiration. Verify against the blocked-strikes list before sending.
            </div>
          )}

          <Button
            onClick={handleLog}
            disabled={!canLog || createFly.isPending}
            data-testid="button-log-fly"
          >
            {createFly.isPending ? "Logging…" : "Log as open position"}
          </Button>
        </div>

        {/* Economics + chain */}
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-card-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Fly economics</h2>
            {!legsComplete ? (
              <p className="text-sm text-muted-foreground">Enter lower &lt; body &lt; upper strikes to compute economics.</p>
            ) : isLive && (!pricing || pricing.midDebit === null) ? (
              <p className="text-sm text-muted-foreground">Strikes not found in live chain for this expiration.</p>
            ) : isLive && pricing && pricing.midDebit !== null ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label="Mid debit" value={fmtUsd(pricing.midDebit)} sub="per share" />
                <Metric label="Worst-case debit" value={fmtUsd(pricing.worstDebit)} sub="ask/bid fills" />
                <Metric label="Max loss" value={fmtUsd(pricing.maxLossMid)} tone="negative" />
                <Metric label="Max profit" value={fmtUsd(pricing.maxProfit)} tone="positive" />
                <Metric label="Breakeven (low)" value={fmtUsd(pricing.breakevenLower)} />
                <Metric label="Breakeven (high)" value={fmtUsd(pricing.breakevenUpper)} />
                <Metric label="Reward:risk" value={pricing.rewardToRiskMid !== null ? `${pricing.rewardToRiskMid.toFixed(2)}:1` : "—"} />
                <Metric label="Structure" value={pricing.isBrokenWing ? "Broken-wing" : "Symmetric"} />
              </div>
            ) : !isLive && !manualPricing ? (
              <p className="text-sm text-muted-foreground">Enter a manual entry debit above to compute economics.</p>
            ) : !isLive && manualPricing ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label="Entry debit" value={fmtUsd(parsedManualDebit)} sub="per share, manual" />
                <Metric label="Max loss" value={fmtUsd(manualPricing.maxLoss)} tone="negative" />
                <Metric label="Max profit" value={fmtUsd(manualPricing.maxProfit)} tone="positive" />
                <Metric label="Reward:risk" value={manualPricing.rewardToRisk !== null ? `${manualPricing.rewardToRisk.toFixed(2)}:1` : "—"} />
                <Metric label="Breakeven (low)" value={fmtUsd(manualPricing.breakevenLower)} />
                <Metric label="Breakeven (high)" value={fmtUsd(manualPricing.breakevenUpper)} />
                <Metric label="Structure" value={manualPricing.isBrokenWing ? "Broken-wing" : "Symmetric"} />
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-card-border bg-card">
            <div className="border-b border-card-border px-4 py-3">
              <h2 className="text-sm font-semibold">
                {optionType === "call" ? "Calls" : "Puts"} · {effectiveExpiration || "—"}
              </h2>
            </div>
            {!isLive ? (
              <div className="p-4 text-sm text-muted-foreground">No live chain for MES.</div>
            ) : chainLoading ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto [overscroll-behavior:contain]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-[1] bg-card">
                    <tr className="border-b border-card-border text-muted-foreground">
                      <th className="px-3 py-2 text-right font-medium">Strike</th>
                      <th className="px-3 py-2 text-right font-medium">Bid</th>
                      <th className="px-3 py-2 text-right font-medium">Ask</th>
                      <th className="px-3 py-2 text-right font-medium">Mid</th>
                      <th className="px-3 py-2 text-right font-medium">OI</th>
                      <th className="px-3 py-2 text-right font-medium">Delta</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {(chain?.options ?? [])
                      .filter((o) => o.expiration === activeExpiration && o.type === optionType)
                      .sort((a, b) => a.strike - b.strike)
                      .map((o) => (
                        <tr
                          key={o.symbol}
                          className={
                            blockedStrikes.has(o.strike)
                              ? "bg-destructive/10"
                              : legsComplete && [legs.lowerStrike, legs.middleStrike, legs.upperStrike].includes(o.strike)
                              ? "bg-primary/10"
                              : ""
                          }
                        >
                          <td className="px-3 py-1.5 text-right">{fmtNum(o.strike, 0)}</td>
                          <td className="px-3 py-1.5 text-right">{fmtNum(o.bid)}</td>
                          <td className="px-3 py-1.5 text-right">{fmtNum(o.ask)}</td>
                          <td className="px-3 py-1.5 text-right">{fmtNum(o.mid)}</td>
                          <td className="px-3 py-1.5 text-right">{o.openInterest}</td>
                          <td className="px-3 py-1.5 text-right">{o.delta !== null ? o.delta.toFixed(2) : "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative";
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          "font-mono text-base font-semibold tabular-nums " +
          (tone === "positive" ? "text-chart-4" : tone === "negative" ? "text-destructive" : "text-foreground")
        }
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
