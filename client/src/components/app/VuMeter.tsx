// Vertical segmented LED meter — mixing-console style — showing where a position's
// live unrealized P&L sits between max loss (bottom, red) and max profit (top, green).
export function VuMeter({
  pnl,
  maxLoss,
  maxProfit,
  segments = 14,
  height = 132,
}: {
  pnl: number;
  maxLoss: number;
  maxProfit: number;
  segments?: number;
  height?: number;
}) {
  // Position pnl on a [-maxLoss, +maxProfit] scale, mapped to [-1, 1], then to [0, segments]
  const lossSpan = Math.max(maxLoss, 1);
  const profitSpan = Math.max(maxProfit, 1);
  const norm = pnl >= 0 ? pnl / profitSpan : pnl / lossSpan; // in [-1, 1] roughly (can exceed slightly)
  const clamped = Math.max(-1, Math.min(1, norm));
  const litFraction = (clamped + 1) / 2; // 0..1 across full stack
  const litCount = Math.round(litFraction * segments);

  const segColor = (idx: number) => {
    // idx 0 = bottom (loss), idx segments-1 = top (profit)
    const p = idx / (segments - 1); // 0..1 bottom..top
    if (p < 0.35) return "#ef4444"; // red — loss zone
    if (p < 0.5) return "#f59e0b"; // amber — near breakeven from below
    if (p < 0.65) return "#f59e0b"; // amber — near breakeven from above
    return "#22c55e"; // green — profit zone
  };

  const segHeight = (height - (segments - 1) * 2) / segments;

  return (
    <div className="flex flex-col-reverse gap-0.5" style={{ height }}>
      {Array.from({ length: segments }).map((_, idx) => {
        const lit = idx < litCount;
        const color = segColor(idx);
        return (
          <div
            key={idx}
            style={{
              height: segHeight,
              background: lit ? color : "#292524",
              boxShadow: lit ? `0 0 5px ${color}99` : "inset 0 0 2px rgba(0,0,0,0.4)",
              transition: "background 0.4s ease, box-shadow 0.4s ease",
            }}
            className="w-full rounded-[2px]"
          />
        );
      })}
    </div>
  );
}
