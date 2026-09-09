import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  ReferenceDot,
} from "recharts";
import { fmtUsd, fmtNum } from "@/lib/format";
import type { PayoffPoint } from "@/lib/flyMath";

type PayoffChartProps = {
  curve: PayoffPoint[];
  spot?: number | null;
  breakevenLower?: number | null;
  breakevenUpper?: number | null;
  height?: number;
};

// Theoretical P&L-at-expiration diagram for a debit butterfly. Pure intrinsic-value
// math from shared/flyMath.buildPayoffCurve -- no fabricated numbers, no simulated
// data. Shows where the position sits relative to breakeven and current spot.
export function PayoffChart({ curve, spot, breakevenLower, breakevenUpper, height = 220 }: PayoffChartProps) {
  if (curve.length === 0) return null;

  const spotPoint =
    spot != null
      ? curve.reduce((closest, p) => (Math.abs(p.price - spot) < Math.abs(closest.price - spot) ? p : closest), curve[0])
      : null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={curve} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="price"
          type="number"
          domain={["dataMin", "dataMax"]}
          tick={{ fontSize: 11 }}
          stroke="hsl(var(--muted-foreground))"
          tickFormatter={(v: number) => fmtNum(v, 0)}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="hsl(var(--muted-foreground))"
          width={64}
          tickFormatter={(v: number) => fmtUsd(v)}
        />
        <Tooltip
          formatter={(v: number) => fmtUsd(v as number)}
          labelFormatter={(l: number) => `Underlying ${fmtNum(l, 2)}`}
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--popover-border))",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
        {breakevenLower != null && (
          <ReferenceLine
            x={breakevenLower}
            stroke="hsl(var(--chart-4))"
            strokeDasharray="2 2"
            label={{ value: "BE", position: "insideTopLeft", fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          />
        )}
        {breakevenUpper != null && (
          <ReferenceLine
            x={breakevenUpper}
            stroke="hsl(var(--chart-4))"
            strokeDasharray="2 2"
            label={{ value: "BE", position: "insideTopRight", fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          />
        )}
        {spot != null && (
          <ReferenceLine
            x={spot}
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            label={{ value: "Spot", position: "top", fontSize: 10, fill: "hsl(var(--primary))" }}
          />
        )}
        <Area
          type="linear"
          dataKey="pnl"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fill="hsl(var(--primary))"
          fillOpacity={0.12}
          dot={false}
          isAnimationActive={false}
        />
        {spotPoint && (
          <ReferenceDot
            x={spotPoint.price}
            y={spotPoint.pnl}
            r={4}
            fill="hsl(var(--primary))"
            stroke="hsl(var(--card))"
            strokeWidth={1.5}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
