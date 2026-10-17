import { useState } from "react";
import type { CampaignWall } from "@shared/schema";
import { useDeleteCampaignWall, useUpdateCampaignWall } from "@/lib/hooks";
import { fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

interface Props {
  symbol: string;
  weekOf: string;
  /** The wall the app is actually using: highest id for this symbol and week. */
  kept: CampaignWall;
  /** The other walls for the same symbol and week, newest first. Never empty when rendered. */
  duplicates: CampaignWall[];
}

/** A pending destructive action, held until the operator confirms it. */
type Intent =
  | { kind: "discard"; wall: CampaignWall }
  | { kind: "promote"; wall: CampaignWall };

function branchTone(branch: string): string {
  if (branch === "pending") return "text-muted-foreground";
  if (branch === "breaks") return "text-chart-2";
  return "text-foreground";
}

/**
 * Resolve several walls existing for one symbol and week down to one.
 *
 * A unique index now prevents new duplicates, but rows created before it -- and rows that exist on
 * any database where the index had to be skipped at boot -- still need a way out that is not hand
 * SQL. Until this is resolved the app picks the highest id and the operator is only warned, which
 * is safe but not finished: the ignored row is still sitting there, and on a re-key it may well be
 * the row holding the reasoning.
 *
 * Two deliberate choices:
 *
 * 1. NOTHING IS DISCARDED BLIND. Every duplicate is shown with its price, branch, reference close
 *    and full notes before any action, and the confirm step repeats them. A wall's notes are the
 *    one part no one can reconstruct, so the operator has to be able to read them at the moment
 *    they decide.
 *
 * 2. "KEEP THIS ONE" COPIES RATHER THAN SWAPS. Selection is by highest id and ids cannot be
 *    reassigned, so promoting an older row means writing its values onto the kept row and then
 *    removing the older one. The outcome is one row carrying the values the operator wanted. This
 *    is stated in the confirm text rather than papered over, because the surviving row's id is not
 *    the one they clicked.
 */
export function DuplicateWallResolver({ symbol, weekOf, kept, duplicates }: Props) {
  const [intent, setIntent] = useState<Intent | null>(null);
  const del = useDeleteCampaignWall();
  const update = useUpdateCampaignWall();
  const { toast } = useToast();
  const busy = del.isPending || update.isPending;

  const run = async () => {
    if (!intent) return;
    const { kind, wall } = intent;
    try {
      if (kind === "promote") {
        // Order matters. The values are copied onto the kept row FIRST, so if the delete fails the
        // week is already correct and the leftover is still visible here to try again. Deleting
        // first would risk losing the values entirely on a failed write.
        await update.mutateAsync({
          id: kept.id,
          patch: {
            symbol: wall.symbol,
            weekOf: wall.weekOf,
            wallPrice: wall.wallPrice,
            referenceClose: wall.referenceClose,
            activeBranch: wall.activeBranch,
            gapPercent: wall.gapPercent,
            reKeyed: wall.reKeyed,
            notes: wall.notes,
          },
        });
        await del.mutateAsync(wall.id);
        toast({
          title: `Kept wall ${fmtUsd(wall.wallPrice)}`,
          description: `Its values now sit on id ${kept.id} for ${symbol} week of ${weekOf}. Id ${wall.id} removed.`,
        });
      } else {
        await del.mutateAsync(wall.id);
        toast({
          title: `Discarded wall id ${wall.id}`,
          description: `${fmtUsd(wall.wallPrice)} · ${wall.activeBranch}. The week still uses id ${kept.id}.`,
        });
      }
      setIntent(null);
    } catch (e: any) {
      toast({
        title: kind === "promote" ? "Could not keep that wall" : "Could not discard that wall",
        description: e?.message ?? "Unknown error. Nothing was changed if this is the first step.",
        variant: "destructive",
      });
    }
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-chart-3/40 bg-chart-3/10 px-3 py-3"
      data-testid="warning-duplicate-walls"
    >
      <div className="text-xs text-chart-3">
        <span className="font-medium">
          {duplicates.length + 1} walls exist for {symbol} week of {weekOf}.
        </span>{" "}
        The app uses the most recent, id {kept.id} at {fmtUsd(kept.wallPrice)} ({kept.activeBranch}).
        The others are ignored but still stored. Resolve them below so the week is unambiguous —
        nothing is deleted until you confirm it.
      </div>

      <div className="flex flex-col gap-2">
        {duplicates.map((w) => (
          <div
            key={w.id}
            className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-2"
            data-testid={`row-duplicate-wall-${w.id}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className="font-mono">
                id {w.id}
              </Badge>
              <span className="font-medium tabular-nums">{fmtUsd(w.wallPrice)}</span>
              <span className={branchTone(w.activeBranch)}>{w.activeBranch}</span>
              {w.reKeyed && <Badge variant="secondary">re-keyed</Badge>}
              {w.referenceClose !== null && (
                <span className="text-muted-foreground">
                  ref close {fmtUsd(w.referenceClose)}
                </span>
              )}
              <span className="text-muted-foreground">
                saved {w.createdAt.slice(0, 10)}
              </span>
            </div>

            {/* Shown in full, never truncated: this is the part that cannot be reconstructed. */}
            {w.notes ? (
              <p
                className="whitespace-pre-wrap text-xs text-muted-foreground"
                data-testid={`text-duplicate-notes-${w.id}`}
              >
                {w.notes}
              </p>
            ) : (
              <p className="text-xs italic text-muted-foreground" data-testid={`text-duplicate-notes-${w.id}`}>
                No notes on this one.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setIntent({ kind: "promote", wall: w })}
                data-testid={`button-promote-wall-${w.id}`}
              >
                Keep this one
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => setIntent({ kind: "discard", wall: w })}
                data-testid={`button-discard-wall-${w.id}`}
              >
                Discard
              </Button>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Uniqueness is enforced by an index created when the service starts, and it is skipped while
        duplicates exist. Once these are resolved it takes effect on the next restart — until then
        the app keeps picking the newest and warning here.
      </p>

      <AlertDialog open={intent !== null} onOpenChange={(o) => !o && setIntent(null)}>
        <AlertDialogContent data-testid="dialog-resolve-wall">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intent?.kind === "promote"
                ? `Keep the ${fmtUsd(intent.wall.wallPrice)} wall?`
                : `Discard wall id ${intent?.wall.id}?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm">
                {intent?.kind === "promote" ? (
                  <>
                    <span>
                      {fmtUsd(intent.wall.wallPrice)} · {intent.wall.activeBranch} will be written
                      onto the wall the app already uses for {symbol} week of {weekOf}, and id{" "}
                      {intent.wall.id} will be removed.
                    </span>
                    <span>
                      The surviving row keeps id {kept.id}, not {intent.wall.id} — ids cannot be
                      reassigned, so the values move rather than the row.
                    </span>
                    <span className="text-muted-foreground">
                      This replaces id {kept.id}'s current {fmtUsd(kept.wallPrice)} ·{" "}
                      {kept.activeBranch}
                      {kept.notes ? ", including its notes" : ""}. That cannot be undone.
                    </span>
                  </>
                ) : (
                  <>
                    <span>
                      {fmtUsd(intent?.wall.wallPrice ?? null)} · {intent?.wall.activeBranch}, saved{" "}
                      {intent?.wall.createdAt.slice(0, 10)}, will be permanently removed.
                    </span>
                    {intent?.wall.notes && (
                      <span className="rounded border border-border bg-muted/40 px-2 py-1.5 text-xs whitespace-pre-wrap">
                        Notes that will be lost: {intent.wall.notes}
                      </span>
                    )}
                    <span className="text-muted-foreground">
                      The week keeps using id {kept.id} at {fmtUsd(kept.wallPrice)}. No trade
                      already stamped with this wall is altered — a logged fly keeps the branch and
                      wall it recorded at entry.
                    </span>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-resolve">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // The dialog closes itself on action; the mutation is awaited above and reports
                // through a toast, so the close is prevented here to keep the busy state visible.
                e.preventDefault();
                void run();
              }}
              disabled={busy}
              data-testid="button-confirm-resolve"
            >
              {busy ? "Working…" : intent?.kind === "promote" ? "Keep it" : "Discard it"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
