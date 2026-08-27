import { useMemo } from "react";
import { Link } from "wouter";
import { StatCard } from "@/components/app/StatCard";
import { useFlies, useCampaignWalls, useSettings } from "@/lib/hooks";
import { computeJournalStats, getMultiplier } from "@/lib/flyMath";
import { fmtUsd, fmtPct, fmtR } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { Button } from "@/components/ui/button";

const BRANCH_LABEL: Record<string, string> = {
  pending: "Pending",
  rejects: "Wall rejects",
  grinds: "Wall grinds",
  breaks: "Wall breaks",
};

export default function Overview() {
  const { data: flies, isLoading: fliesLoading } = useFlies();
  const { data: walls, isLoading: wallsLoading } = useCampaignWalls();
  const { data: settings, isLoading: settingsLoading } = useSettings();

  const loading = fliesLoading || wallsLoading || settingsLoading;

  const openFlies = useMemo(() => (flies ?? []).filter((f) => f.status === "open"), [flies]);
  const closedFlies = useMemo(() => (flies ?? []).filter((f) => f.status === "closed"), [flies]);

  const capitalDeployed = useMemo(
    () => openFlies.reduce((s, f) => s + f.maxLoss, 0),
    [openFlies]
  );

  const stats = useMemo(() => computeJournalStats(closedFlies), [closedFlies]);

  const equityCurve = useMemo(() => {
    const sorted = [...closedFlies].sort(
      (a, b) => new Date(a.exitDate ?? a.entryDate).getTime() - new Date(b.exitDate ?? b.entryDate).getTime()
    );
    let cumulative = 0;
    return sorted.map((f, i) => {
      const pnl = ((f.exitDebit ?? 0) - f.entryDebit) * getMultiplier(f.symbol) * f.contracts;
      cumulative += pnl;
      return { trade: i + 1, date: f.exitDate ?? f.entryDate, equity: Number(cumulative.toFixed(2)) };
    });
  }, [closedFlies]);

  const activeWall = useMemo(() => {
    if (!walls || walls.length === 0) return undefined;
    return [...walls].sort((a, b) => new Date(b.weekOf).getTime() - new Date(a.weekOf).getTime())[0];
  }, [walls]);

  const accountBalance = settings?.accountBalance ?? 1000;
  const capitalPct = accountBalance > 0 ? capitalDeployed / accountBalance : 0;

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4" data-testid="grid-overview-stats">
        <StatCard
          label="Account balance"
          value={fmtUsd(accountBalance)}
          testId="stat-account-balance"
        />
        <StatCard
          label="Capital deployed"
          value={fmtUsd(capitalDeployed)}
          sub={`${fmtPct(capitalPct)} of balance · ${openFlies.length} open`}
          tone={capitalPct > 0.5 ? "negative" : "accent"}
          testId="stat-capital-deployed"
        />
        <StatCard
          label="Realized P&L"
          value={fmtUsd(stats.totalPnl, { signed: true })}
          tone={stats.totalPnl >= 0 ? "positive" : "negative"}
          sub={`${stats.tradeCount} closed trades`}
          testId="stat-realized-pnl"
        />
        <StatCard
          label="Win rate"
          value={fmtPct(stats.winRate)}
          testId="stat-win-rate"
        />
        <StatCard
          label="Profit factor"
          value={stats.profitFactor === null ? "—" : stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}
          testId="stat-profit-factor"
        />
        <StatCard
          label="Avg R / trade"
          value={fmtR(stats.avgR)}
          testId="stat-avg-r"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-lg border border-card-border bg-card p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Equity curve</h2>
            <span className="text-xs text-muted-foreground">Cumulative realized P&L</span>
          </div>
          {equityCurve.length === 0 ? (
            <div className="flex h-52 items-center justify-center text-sm text-muted-foreground">
              No closed trades yet — log a fly in the Journal to see your curve.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={equityCurve} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="trade" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={60} />
                <Tooltip
                  formatter={(v: number) => fmtUsd(v)}
                  labelFormatter={(l) => `Trade ${l}`}
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--popover-border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Line type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="rounded-lg border border-card-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Campaign status</h2>
            <Link href="/campaign">
              <a className="text-xs text-primary hover:underline" data-testid="link-view-campaign">
                View
              </a>
            </Link>
          </div>
          {activeWall ? (
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Symbol</span>
                <span className="font-mono font-medium">{activeWall.symbol}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Week of</span>
                <span className="font-mono">{activeWall.weekOf}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Wall price</span>
                <span className="font-mono">{fmtUsd(activeWall.wallPrice)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Branch</span>
                <Badge variant={activeWall.activeBranch === "pending" ? "outline" : "default"}>
                  {BRANCH_LABEL[activeWall.activeBranch] ?? activeWall.activeBranch}
                </Badge>
              </div>
              {activeWall.reKeyed && (
                <Badge variant="destructive" className="w-fit">
                  Re-keyed on gap
                </Badge>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 text-sm text-muted-foreground">
              No wall keyed for this week yet.
              <Link href="/campaign" asChild>
                <Button size="sm" variant="outline" data-testid="button-key-wall">
                  Key this week's wall
                </Button>
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
