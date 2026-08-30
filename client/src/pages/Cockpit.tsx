// The Cockpit — a mixing-console style command center. Radial dials for portfolio-level
// risk/decay, and a channel strip per open position with a live P&L VU meter and
// wall-proximity LEDs, plus a rule-based nudge panel telling you what to watch right now.
import { useMemo } from "react";
import type { Fly } from "@shared/schema";
import { useFlies, useSettings, useCampaignWalls, useFliesLivePricing, useQuotesFor, type FlyPriceResponse } from "@/lib/hooks";
import { getMultiplier } from "@/lib/flyMath";
import { fmtUsd, fmtPct } from "@/lib/format";
import { RadialGauge } from "@/components/app/RadialGauge";
import { VuMeter } from "@/components/app/VuMeter";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, CheckCircle2, Info, TrendingDown, TrendingUp } from "lucide-react";

type Nudge = { level: "good" | "info" | "warn" | "danger"; text: string };

// Nudge thresholds now live in shared/thresholds.ts so the Journal's threshold-review
// panel can reference the exact same regime this page uses for live nudges.
import {
  TAKE_PROFIT_PCT,
  STOP_LOSS_PCT,
  GAMMA_WARNING_DTE,
  WING_BREACH_URGENT_DTE,
  CAPITAL_WARN_PCT,
  CAPITAL_DANGER_PCT,
} from "@shared/thresholds";

function daysToExpiry(expiration: string): number {
  const now = new Date();
  const exp = new Date(`${expiration}T16:00:00`);
  return Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}

function Led({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="h-2 w-2 rounded-full"
        style={{ background: color, boxShadow: `0 0 6px ${color}, 0 0 2px ${color}` }}
      />
      <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{label}</span>
    </div>
  );
}

function ChannelStrip({
  fly,
  pricing,
  spot,
}: {
  fly: Fly;
  pricing: FlyPriceResponse | undefined;
  spot: number | null;
}) {
  const multiplier = getMultiplier(fly.symbol);
  const liveDebit = pricing?.midDebit ?? null;
  const unrealizedPnl = liveDebit !== null ? (liveDebit - fly.entryDebit) * multiplier * fly.contracts : null;
  const dte = daysToExpiry(fly.expiration);
  const distToBodyPct = spot !== null && fly.middleStrike > 0 ? ((spot - fly.middleStrike) / fly.middleStrike) * 100 : null;

  // Distance-to-body relative to the fly's own wing width, not a fixed %, so a tight
  // fly and a wide fly are judged on the same scale (how far through the wing spot has moved).
  const halfWidth = ((fly.middleStrike - fly.lowerStrike) + (fly.upperStrike - fly.middleStrike)) / 2;
  const wingProgress = spot !== null && halfWidth > 0 ? Math.abs(spot - fly.middleStrike) / halfWidth : null;
  const outsideWing = spot !== null && (spot <= fly.lowerStrike || spot >= fly.upperStrike);
  // Only treat an out-of-range spot as a real max-loss risk once time value has mostly decayed —
  // with days still on the clock, live P&L (from the actual chain) is the accurate read, not this.
  const outsideWingIsUrgent = outsideWing && dte <= WING_BREACH_URGENT_DTE;

  let statusColor = "#78716c";
  let statusLabel = "SYNCING";
  if (unrealizedPnl !== null) {
    const pctOfMaxProfit = fly.maxProfit > 0 ? unrealizedPnl / fly.maxProfit : 0;
    const pctOfMaxLoss = fly.maxLoss > 0 ? unrealizedPnl / fly.maxLoss : 0;
    if (pctOfMaxProfit >= TAKE_PROFIT_PCT) {
      statusColor = "#22c55e";
      statusLabel = "PROFIT ZONE";
    } else if (pctOfMaxLoss <= STOP_LOSS_PCT) {
      statusColor = "#ef4444";
      statusLabel = "STOP ZONE";
    } else if (unrealizedPnl >= 0) {
      statusColor = "#84cc16";
      statusLabel = "GREEN";
    } else {
      statusColor = "#f59e0b";
      statusLabel = "WATCH";
    }
  }

  let wallColor = "#78716c";
  let wallLabel = "—";
  if (wingProgress !== null) {
    if (wingProgress <= 0.25) {
      wallColor = "#22c55e";
      wallLabel = "PINNED";
    } else if (wingProgress <= 1) {
      wallColor = "#f59e0b";
      wallLabel = "IN RANGE";
    } else {
      wallColor = outsideWingIsUrgent ? "#ef4444" : "#a8a29e";
      wallLabel = "OUTSIDE WING";
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-stone-800 bg-stone-950 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
              fly.optionType === "call" ? "bg-sky-950 text-sky-300" : "bg-violet-950 text-violet-300"
            }`}
          >
            {fly.optionType}
          </span>
          <span className="font-mono text-xs text-stone-200">
            {fly.lowerStrike}/{fly.middleStrike}/{fly.upperStrike}
          </span>
        </div>
        <Led color={statusColor} label={statusLabel} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col items-center gap-1">
          <VuMeter pnl={unrealizedPnl ?? 0} maxLoss={fly.maxLoss} maxProfit={fly.maxProfit} height={110} segments={12} />
          <span className="text-[9px] uppercase text-stone-500">P&amp;L</span>
        </div>
        <div className="flex flex-1 flex-col gap-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-stone-500">Live P&amp;L</span>
            <span
              className={`font-mono font-semibold ${
                unrealizedPnl === null ? "text-stone-500" : unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {unrealizedPnl === null ? "—" : fmtUsd(unrealizedPnl, { signed: true })}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-stone-500">Max loss / profit</span>
            <span className="font-mono text-stone-300">
              {fmtUsd(fly.maxLoss)} / {fmtUsd(fly.maxProfit)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-stone-500">DTE</span>
            <span className={`font-mono ${dte <= GAMMA_WARNING_DTE ? "text-amber-400" : "text-stone-300"}`}>{dte}d</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-stone-500">Spot vs body</span>
            <span className="font-mono text-stone-300">
              {distToBodyPct === null ? "—" : `${distToBodyPct > 0 ? "+" : ""}${distToBodyPct.toFixed(2)}%`}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-stone-800 pt-1.5">
            <span className="text-stone-500">Wall proximity</span>
            <Led color={wallColor} label={wallLabel} />
          </div>
        </div>
      </div>
      {outsideWing && (
        <div
          className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] font-semibold ${
            outsideWingIsUrgent
              ? "border-red-900 bg-red-950/60 text-red-300"
              : "border-stone-700 bg-stone-900/60 text-stone-400"
          }`}
        >
          <AlertTriangle className="h-3 w-3" />
          {outsideWingIsUrgent
            ? `Spot is outside the wing with ${dte}d left — little time value cushion remains.`
            : `Spot is outside the wing, but ${dte}d of time value still cushions this — live P&L above is the accurate read.`}
        </div>
      )}
    </div>
  );
}

export default function Cockpit() {
  const { data: flies, isLoading: fliesLoading } = useFlies();
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: walls } = useCampaignWalls();

  const openFlies = useMemo(() => (flies ?? []).filter((f) => f.status === "open"), [flies]);
  const pricingResults = useFliesLivePricing(openFlies);
  const uniqueSymbols = useMemo(() => Array.from(new Set(openFlies.map((f) => f.symbol))), [openFlies]);
  const quoteResults = useQuotesFor(uniqueSymbols);

  const spotBySymbol = useMemo(() => {
    const map = new Map<string, number>();
    uniqueSymbols.forEach((s, i) => {
      const q = quoteResults[i]?.data as { spot?: number } | undefined;
      if (q?.spot) map.set(s, q.spot);
    });
    return map;
  }, [uniqueSymbols, quoteResults]);

  const accountBalance = settings?.accountBalance ?? 1000;
  const capitalDeployed = useMemo(() => openFlies.reduce((s, f) => s + f.maxLoss, 0), [openFlies]);
  const capitalPct = accountBalance > 0 ? capitalDeployed / accountBalance : 0;

  const positionPnls = useMemo(
    () =>
      openFlies.map((f, i) => {
        const pricing = pricingResults[i]?.data as FlyPriceResponse | undefined;
        const multiplier = getMultiplier(f.symbol);
        const liveDebit = pricing?.midDebit ?? null;
        const pnl = liveDebit !== null ? (liveDebit - f.entryDebit) * multiplier * f.contracts : null;
        return { fly: f, pricing, pnl };
      }),
    [openFlies, pricingResults]
  );

  const totalUnrealized = useMemo(
    () => positionPnls.reduce((s, p) => (p.pnl !== null ? s + p.pnl : s), 0),
    [positionPnls]
  );
  const totalMaxLoss = useMemo(() => openFlies.reduce((s, f) => s + f.maxLoss, 0), [openFlies]);
  const totalMaxProfit = useMemo(() => openFlies.reduce((s, f) => s + f.maxProfit, 0), [openFlies]);

  const nearestDte = useMemo(() => {
    if (openFlies.length === 0) return null;
    return Math.min(...openFlies.map((f) => daysToExpiry(f.expiration)));
  }, [openFlies]);

  const activeWall = useMemo(() => {
    if (!walls || walls.length === 0) return undefined;
    return [...walls].sort((a, b) => new Date(b.weekOf).getTime() - new Date(a.weekOf).getTime())[0];
  }, [walls]);

  const nudges = useMemo<Nudge[]>(() => {
    const list: Nudge[] = [];
    if (openFlies.length === 0) {
      list.push({ level: "info", text: "No open positions — cockpit will light up once a fly is logged." });
      return list;
    }
    if (capitalPct >= CAPITAL_DANGER_PCT) {
      list.push({ level: "danger", text: `Capital deployed is ${fmtPct(capitalPct)} of the $${accountBalance} account — high aggregate exposure, hold off on new adds.` });
    } else if (capitalPct >= CAPITAL_WARN_PCT) {
      list.push({ level: "warn", text: `Capital deployed is ${fmtPct(capitalPct)} of the account — within budget, but watch before stacking more positions.` });
    } else {
      list.push({ level: "good", text: `Capital deployed is ${fmtPct(capitalPct)} of the account — plenty of room left.` });
    }

    positionPnls.forEach(({ fly, pnl }) => {
      const label = `${fly.optionType.toUpperCase()} ${fly.lowerStrike}/${fly.middleStrike}/${fly.upperStrike}`;
      if (pnl === null) return;
      const pctProfit = fly.maxProfit > 0 ? pnl / fly.maxProfit : 0;
      const pctLoss = fly.maxLoss > 0 ? pnl / fly.maxLoss : 0;
      if (pctProfit >= TAKE_PROFIT_PCT) {
        list.push({ level: "good", text: `${label} is at ${fmtPct(pctProfit)} of max profit — take-profit zone, consider locking in gains.` });
      } else if (pctLoss <= STOP_LOSS_PCT) {
        list.push({ level: "danger", text: `${label} is down ${fmtPct(Math.abs(pctLoss))} of max loss — stop zone, consider cutting.` });
      }
      const dte = daysToExpiry(fly.expiration);
      if (dte <= GAMMA_WARNING_DTE) {
        list.push({ level: "warn", text: `${label} has ${dte} day(s) to expiry — gamma risk accelerating into the close.` });
      }
      const spot = spotBySymbol.get(fly.symbol);
      const halfWidth = ((fly.middleStrike - fly.lowerStrike) + (fly.upperStrike - fly.middleStrike)) / 2;
      if (spot !== undefined && halfWidth > 0) {
        const outside = spot <= fly.lowerStrike || spot >= fly.upperStrike;
        const dte = daysToExpiry(fly.expiration);
        if (outside && dte <= WING_BREACH_URGENT_DTE) {
          list.push({ level: "danger", text: `${label}: spot ($${spot.toFixed(2)}) is outside the wing with ${dte}d left — little time value cushion remains.` });
        } else if (outside) {
          list.push({ level: "warn", text: `${label}: spot ($${spot.toFixed(2)}) is outside the wing, but ${dte}d of time value still cushions it — live P&L is the accurate read, not the strike position.` });
        } else if (Math.abs(spot - fly.middleStrike) / halfWidth <= 0.25) {
          list.push({ level: "good", text: `${label}: spot is pinned near the body ($${fly.middleStrike}) — ideal outcome zone.` });
        }
      }
    });

    if (activeWall && activeWall.activeBranch !== "pending") {
      list.push({ level: "info", text: `Campaign branch is "${activeWall.activeBranch === "rejects" ? "Wall rejects" : activeWall.activeBranch === "grinds" ? "Wall grinds" : "Wall breaks"}" for the week — cross-check new entries against that script.` });
    }

    return list;
  }, [openFlies, positionPnls, capitalPct, accountBalance, spotBySymbol, activeWall]);

  const nudgeIcon = (level: Nudge["level"]) => {
    if (level === "good") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
    if (level === "warn") return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
    if (level === "danger") return <TrendingDown className="h-3.5 w-3.5 text-red-400" />;
    return <Info className="h-3.5 w-3.5 text-sky-400" />;
  };

  const loading = fliesLoading || settingsLoading;

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-40 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Master panel */}
      <div
        className="rounded-xl border border-stone-800 p-5"
        style={{
          background:
            "linear-gradient(180deg, #1c1917 0%, #14110f 60%, #100d0b 100%)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 8px 24px rgba(0,0,0,0.4)",
        }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-widest text-stone-400">Master Panel</h2>
          <div className="flex items-center gap-3">
            <Led color={openFlies.length > 0 ? "#22c55e" : "#78716c"} label={openFlies.length > 0 ? "Live" : "Idle"} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <RadialGauge
            value={capitalPct * 100}
            min={0}
            max={25}
            label="Risk Utilization"
            valueLabel={fmtPct(capitalPct)}
            sublabel={`${fmtUsd(capitalDeployed)} of ${fmtUsd(accountBalance)}`}
            zones={[
              { upTo: 0.4, color: "#22c55e" },
              { upTo: 0.8, color: "#f59e0b" },
              { upTo: 1, color: "#ef4444" },
            ]}
          />
          <RadialGauge
            value={Math.max(-totalMaxLoss, Math.min(totalMaxLoss, totalUnrealized))}
            min={-Math.max(totalMaxLoss, 1)}
            max={Math.max(totalMaxLoss, 1)}
            label="Portfolio P&amp;L"
            valueLabel={fmtUsd(totalUnrealized, { signed: true })}
            sublabel={`vs ${fmtUsd(totalMaxLoss)} risked · center = breakeven`}
            zones={[
              { upTo: 0.45, color: "#ef4444" },
              { upTo: 0.55, color: "#f59e0b" },
              { upTo: 1, color: "#22c55e" },
            ]}
          />
          <RadialGauge
            value={nearestDte ?? 10}
            min={0}
            max={10}
            label="Nearest DTE"
            valueLabel={nearestDte === null ? "—" : `${nearestDte}d`}
            sublabel="Time to soonest expiry"
            zones={[
              { upTo: 0.2, color: "#ef4444" },
              { upTo: 0.4, color: "#f59e0b" },
              { upTo: 1, color: "#22c55e" },
            ]}
          />
          <RadialGauge
            value={openFlies.length}
            min={0}
            max={5}
            label="Open Channels"
            valueLabel={String(openFlies.length)}
            sublabel="Active positions"
            zones={[
              { upTo: 0.6, color: "#22c55e" },
              { upTo: 0.8, color: "#f59e0b" },
              { upTo: 1, color: "#ef4444" },
            ]}
          />
        </div>
      </div>

      {/* Channel strips */}
      <div>
        <h2 className="mb-3 text-xs font-bold uppercase tracking-widest text-stone-400">Channel Strips</h2>
        {openFlies.length === 0 ? (
          <div className="rounded-lg border border-stone-800 bg-stone-950 p-6 text-center text-sm text-stone-500">
            No open positions. Build a fly and log it to see it patched in here.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {positionPnls.map(({ fly, pricing }) => (
              <ChannelStrip key={fly.id} fly={fly} pricing={pricing} spot={spotBySymbol.get(fly.symbol) ?? null} />
            ))}
          </div>
        )}
      </div>

      {/* Nudge panel */}
      <div className="rounded-xl border border-stone-800 bg-stone-950 p-4">
        <div className="mb-3 flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-stone-400" />
          <h2 className="text-xs font-bold uppercase tracking-widest text-stone-400">Signal Panel</h2>
        </div>
        <div className="flex flex-col gap-2">
          {nudges.map((n, i) => (
            <div key={i} className="flex items-start gap-2 rounded-md bg-stone-900/60 px-3 py-2 text-[12px] text-stone-200">
              {nudgeIcon(n.level)}
              <span>{n.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
