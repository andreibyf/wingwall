// Headless background tracker — mounted once in App.tsx (not tied to any single page) so
// peak-profit / peak-trough tracking keeps running no matter which dashboard tab is active,
// not just while the Cockpit page happens to be mounted.
//
// IMPORTANT LIMITATION: this only samples while a browser tab has the dashboard open. There
// is no server-side background job, so any price swing that happens while every tab is closed
// is NOT captured — peaks are a lower bound on the true intraday extreme, not a guarantee.
// Surface this caveat anywhere peak stats are shown (see Journal's Threshold Review panel).
import { useEffect, useRef } from "react";
import { useFlies, useFliesLivePricing, useTrackFlyExtreme, type FlyPriceResponse } from "@/lib/hooks";
import { getMultiplier } from "@/lib/flyMath";

export function ExtremeTracker() {
  const { data: flies } = useFlies();
  const openFlies = (flies ?? []).filter((f) => f.status === "open");
  const pricingResults = useFliesLivePricing(openFlies);
  const trackExtreme = useTrackFlyExtreme();

  // Client-side dedupe on top of the server's own ratchet-only no-op: avoids firing a
  // network call every 10s poll tick when nothing has actually moved for a given fly.
  const lastSent = useRef<Map<number, { profit: number; loss: number }>>(new Map());

  // Only re-run the effect when a fly's live mid actually changes, not on every render.
  const signature = openFlies
    .map((f, i) => `${f.id}:${(pricingResults[i]?.data as FlyPriceResponse | undefined)?.midDebit ?? "x"}`)
    .join(",");

  useEffect(() => {
    openFlies.forEach((fly, i) => {
      const price = pricingResults[i]?.data as FlyPriceResponse | undefined;
      if (!price || price.midDebit === null || price.midDebit === undefined) return;

      // Same formula as the Cockpit's unrealized P&L (must stay in sync with Cockpit.tsx).
      const multiplier = getMultiplier(fly.symbol);
      const pnl = (price.midDebit - fly.entryDebit) * multiplier * fly.contracts;
      const profitPct = fly.maxProfit > 0 ? pnl / fly.maxProfit : 0;
      const lossPct = fly.maxLoss > 0 ? pnl / fly.maxLoss : 0;

      const prevPeakProfit = fly.peakProfitPct ?? -Infinity;
      const prevPeakLoss = fly.peakLossPct ?? Infinity;
      const isNewExtreme = profitPct > prevPeakProfit || lossPct < prevPeakLoss;
      if (!isNewExtreme) return;

      const last = lastSent.current.get(fly.id);
      if (last && profitPct <= last.profit && lossPct >= last.loss) return; // already reported

      lastSent.current.set(fly.id, {
        profit: Math.max(profitPct, prevPeakProfit),
        loss: Math.min(lossPct, prevPeakLoss),
      });
      trackExtreme.mutate({ id: fly.id, profitPct, lossPct });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return null; // no UI — pure background effect
}
