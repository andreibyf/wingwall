// Analog-style radial gauge (270° sweep, 45° gap at bottom) used across the Cockpit
// to render risk, P&L, and time-decay dials in a mixing-console aesthetic.
import { useMemo } from "react";

export type GaugeZone = { upTo: number; color: string };

export function RadialGauge({
  value,
  min,
  max,
  size = 132,
  strokeWidth = 10,
  label,
  valueLabel,
  sublabel,
  zones,
  needleColor = "#f5f5f4",
}: {
  value: number;
  min: number;
  max: number;
  size?: number;
  strokeWidth?: number;
  label: string;
  valueLabel: string;
  sublabel?: string;
  zones: GaugeZone[]; // ordered, upTo is normalized 0..1 fraction of [min,max]
  needleColor?: string;
}) {
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const sweep = 270; // degrees
  const startAngle = 135; // degrees, bottom-left, measured clockwise from 3 o'clock (SVG rotate convention)
  const circumference = 2 * Math.PI * r;
  const arcLen = (sweep / 360) * circumference;

  const clamped = Math.max(min, Math.min(max, value));
  const frac = max > min ? (clamped - min) / (max - min) : 0;

  const activeColor = useMemo(() => {
    let color = zones[0]?.color ?? needleColor;
    for (const z of zones) {
      if (frac <= z.upTo) {
        color = z.color;
        break;
      }
      color = z.color;
    }
    return color;
  }, [frac, zones, needleColor]);

  // Needle rotation: starts at startAngle, sweeps `sweep` degrees clockwise as frac 0->1
  const needleRotation = startAngle + frac * sweep;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        {/* Track */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="#292524"
          strokeWidth={strokeWidth}
          strokeDasharray={`${arcLen} ${circumference}`}
          strokeLinecap="round"
          transform={`rotate(${startAngle} ${cx} ${cy})`}
        />
        {/* Zone ticks (subtle color bands under the value arc) */}
        {zones.map((z, i) => {
          const prevUpTo = i === 0 ? 0 : zones[i - 1].upTo;
          const zoneLen = (z.upTo - prevUpTo) * arcLen;
          const zoneOffset = prevUpTo * arcLen;
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={z.color}
              strokeOpacity={0.28}
              strokeWidth={strokeWidth}
              strokeDasharray={`${zoneLen} ${circumference}`}
              strokeDashoffset={-zoneOffset}
              strokeLinecap="butt"
              transform={`rotate(${startAngle} ${cx} ${cy})`}
            />
          );
        })}
        {/* Value arc */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={activeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={`${frac * arcLen} ${circumference}`}
          strokeLinecap="round"
          transform={`rotate(${startAngle} ${cx} ${cy})`}
          style={{ filter: `drop-shadow(0 0 4px ${activeColor}99)`, transition: "stroke-dasharray 0.5s ease, stroke 0.5s ease" }}
        />
        {/* Needle */}
        <g transform={`rotate(${needleRotation} ${cx} ${cy})`} style={{ transition: "transform 0.5s ease" }}>
          <line x1={cx} y1={cy} x2={cx + r - strokeWidth * 0.6} y2={cy} stroke={needleColor} strokeWidth={2} strokeLinecap="round" />
        </g>
        <circle cx={cx} cy={cy} r={3.5} fill={needleColor} />
        {/* Center readout */}
        <text x={cx} y={cy + r * 0.42} textAnchor="middle" fontSize={size * 0.135} fontWeight={700} fill="#f5f5f4" fontFamily="'JetBrains Mono', monospace">
          {valueLabel}
        </text>
      </svg>
      <div className="text-center">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-stone-300">{label}</div>
        {sublabel && <div className="text-[10px] text-stone-500">{sublabel}</div>}
      </div>
    </div>
  );
}
