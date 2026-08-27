import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "positive" | "negative" | "accent";
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border border-card-border bg-card p-4"
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1.5 text-2xl font-bold tabular-nums",
          tone === "positive" && "text-chart-4",
          tone === "negative" && "text-destructive",
          tone === "accent" && "text-primary",
          tone === "neutral" && "text-foreground"
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
