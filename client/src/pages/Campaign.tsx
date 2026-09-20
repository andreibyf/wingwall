import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  useCampaignWalls,
  useCreateCampaignWall,
  useUpdateCampaignWall,
  useResolveDuplicateWalls,
  useFlies,
  useChecklist,
  useUpdateChecklist,
} from "@/lib/hooks";
import { fmtUsd, fmtPct, weekOfMonday } from "@/lib/format";
import { canonicalWall, duplicateWallGroups } from "@shared/wall-selection";
import type { CampaignWall } from "@shared/schema";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

const BRANCHES = [
  {
    value: "rejects",
    label: "Wall rejects",
    description: "Price fades below the wall — base case. Enter bear-ladder + satellite fly as written.",
  },
  {
    value: "grinds",
    label: "Wall grinds",
    description: "Price holds at the wall — re-center. Shift fly bodies ~2% below open, satellite ~3% below.",
  },
  {
    value: "breaks",
    label: "Wall breaks",
    description: "Sustained push through the wall — bull branch. Cut bear ladder to fewer lots, pull Thursday reserve fly forward as primary, skip gap-patch ticket.",
  },
];

const CHECKLIST_ITEMS: { key: keyof ChecklistPatch; label: string }[] = [
  { key: "noEarlyFills", label: "No fills in first 15 minutes" },
  { key: "workingWindowRespected", label: "Working window respected (9:45–10:30 AM ET)" },
  { key: "clippedSizing", label: "Orders clipped to 2–3 lots" },
  { key: "blockedStrikesVerified", label: "Strikes verified against blocked-strikes list" },
  { key: "fillsLogged", label: "Every fill logged" },
  { key: "thursdayReserveDeployed", label: "Thursday reserve deployed post-crush" },
  { key: "fridayCurfewRespected", label: "Friday 2 PM curfew respected (exits only)" },
];

type ChecklistPatch = {
  noEarlyFills: boolean;
  workingWindowRespected: boolean;
  clippedSizing: boolean;
  blockedStrikesVerified: boolean;
  fillsLogged: boolean;
  thursdayReserveDeployed: boolean;
  fridayCurfewRespected: boolean;
};

const GAP_THRESHOLD = 0.025;

// Gexbot publishes the major positive/negative GEX levels by open interest and the
// zero-gamma line. Wingwall's wall is an OVERHEAD level, so the major POSITIVE level is
// the wall analogue; the major negative level is the downside acceleration band. These are
// levels, not exchange strikes -- QQQ lists $1 increments and the live value was 720.02 --
// so they are shown as published and never rounded to a strike. The keyed
// wall stays the operator's number -- these are advisory, with an override button so keying
// it does not mean retyping it.
type GexLevels = {
  symbol: string;
  category?: string | null;
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
  gammaFlipStatus: string | null;
  regime: string | null;
  spot?: number | null;
  netGexOi?: number | null;
  providerTimestamp?: number | null;
  fetchedAt?: string;
};

type GexStatus = {
  configured: boolean;
  envVarName: string | null;
  keyPrefixAdded: boolean;
  tier: string;
  symbol: string;
  symbolCovered: boolean;
  category: string;
  callsToday: number;
  quotaPool: string;
  quotaResetsAt: string;
  etDate: string;
  refreshedDailyAt: string;
  cached: GexLevels | null;
};

type GexRefresh =
  | { ok: true; tier: string; category: string; callsToday: number; levels: GexLevels }
  | { ok: false; reason: string; detail: string; tier?: string; category?: string; callsToday?: number };

function fmtLevel(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toFixed(2);
}

export default function Campaign() {
  const { toast } = useToast();
  const [symbol, setSymbol] = useState("QQQ");
  const weekOf = weekOfMonday();

  const { data: walls } = useCampaignWalls();
  const createWall = useCreateCampaignWall();
  const updateWall = useUpdateCampaignWall();
  const { data: flies } = useFlies();
  const { data: checklist } = useChecklist(weekOf);
  const updateChecklist = useUpdateChecklist(weekOf);

  // Status is cheap and makes no upstream call, so it can load on mount. The refresh
  // mutation is the only thing that spends quota, and only when clicked.
  const { data: gexStatus, refetch: refetchGexStatus } = useQuery<GexStatus>({
    queryKey: ["/api/gexbot/status"],
  });
  const [gexError, setGexError] = useState<string | null>(null);
  const [gexFresh, setGexFresh] = useState<GexRefresh | null>(null);

  const gexRefresh = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/gexbot/refresh", { symbol });
      return (await res.json()) as GexRefresh;
    },
    onSuccess: (data) => {
      setGexFresh(data);
      if (data.ok) {
        setGexError(null);
        toast({
          title: "Gexbot levels updated",
          description: `${data.category} · ${data.callsToday} api_majors call(s) used today`,
        });
      } else {
        // A quota breach and a tier restriction are ordinary operating states, not faults,
        // so they are titled as limitations rather than failures.
        setGexError(data.detail);
        const benign = data.reason === "tier_or_permission" || data.reason === "rate_limited" || data.reason === "not_covered";
        toast({
          title: benign ? "Gexbot levels unavailable" : "Gexbot request failed",
          description: data.detail,
          variant: "destructive",
        });
      }
      refetchGexStatus();
    },
    onError: (e: any) => {
      setGexError(e?.message ?? String(e));
      toast({ title: "Gexbot request failed", description: e?.message, variant: "destructive" });
    },
  });

  // Prefer the levels just fetched; fall back to whatever was cached server-side.
  const gexLevels = useMemo<GexLevels | null>(() => {
    if (gexFresh && gexFresh.ok) return gexFresh.levels;
    return gexStatus?.cached ?? null;
  }, [gexFresh, gexStatus]);

  // The wall is an OVERHEAD level: every branch is defined by how price behaves against a
  // level ABOVE it. Writing a below-spot level into the wall does not merely mis-key it, it
  // inverts the reading -- price would already sit above the wall, which the engine scores as
  // sustained-through, so a support level silently presents as a confirmed BULL breaks branch.
  // That is the worst possible failure shape here: not an error, a plausible wrong answer.
  //
  // This is not hypothetical. On 2026-09-20 Gexbot returned a major +GEX of 720.02 against a
  // spot of 721.31, so the very first live response would have set a below-spot wall.
  const overrideGuard = useMemo(() => {
    const level = gexLevels?.callWall;
    if (level === null || level === undefined) {
      return { blocked: true, reason: null as string | null, gap: null as number | null };
    }
    const spot = gexLevels?.spot;
    if (spot === null || spot === undefined) {
      // Gexbot documents spot as null when it is not available to the caller. Unverifiable is
      // not the same as wrong, so this warns instead of blocking -- but it does say plainly
      // that the check did not run, rather than implying a pass.
      return {
        blocked: false,
        reason:
          `Cannot verify ${level.toFixed(2)} sits above spot: the provider returned no spot on ` +
          `this key. Check it against the tape before saving.`,
        gap: null,
      };
    }
    if (level <= spot) {
      // Equality is blocked with the rest. A wall exactly at spot is not overhead either, and
      // it leaves the branch read undefined at the open rather than merely wrong.
      const position =
        level === spot
          ? `sits exactly AT the provider spot of ${spot.toFixed(2)}`
          : `is ${(spot - level).toFixed(2)} BELOW the provider spot of ${spot.toFixed(2)}`;
      return {
        blocked: true,
        reason:
          `Blocked: the major +GEX of ${level.toFixed(2)} ${position}, so it is not an overhead ` +
          `wall. Keying it would read as price already at or through the wall and score a false ` +
          `breaks (bull) branch. Use it as a downside marker instead.`,
        gap: level - spot,
      };
    }
    return { blocked: false, reason: null, gap: level - spot };
  }, [gexLevels]);

  // The row this form edits. Resolved with the shared canonical rule (highest id for the
  // symbol + week) rather than `find()` over the created_at-ordered list, so the form always
  // edits the same row the proposal engine and the copilot read. Those two used to be able to
  // disagree, which meant a branch change could appear saved while the engine traded another
  // row's branch.
  const existing = useMemo(
    () => canonicalWall(walls ?? [], symbol, weekOf),
    [walls, symbol, weekOf]
  );

  // Duplicated symbol + week groups anywhere in the book, current week first. Empty in the
  // normal case, and the panel below renders nothing then -- a permanent "no duplicates"
  // banner would just train the operator to ignore the spot where the warning appears.
  const dupGroups = useMemo(() => {
    const groups = duplicateWallGroups(walls ?? []);
    return groups.sort((a, b) => {
      const aCurrent = a.symbol === symbol && a.weekOf === weekOf ? 0 : 1;
      const bCurrent = b.symbol === symbol && b.weekOf === weekOf ? 0 : 1;
      return aCurrent - bCurrent;
    });
  }, [walls, symbol, weekOf]);

  const currentWeekDuped = dupGroups.some((g) => g.symbol === symbol && g.weekOf === weekOf);

  const [wallPrice, setWallPrice] = useState("");
  const [referenceClose, setReferenceClose] = useState("");
  const [activeBranch, setActiveBranch] = useState("pending");
  const [notes, setNotes] = useState("");
  const [gapPrint, setGapPrint] = useState("");

  useEffect(() => {
    if (existing) {
      setWallPrice(String(existing.wallPrice));
      setReferenceClose(existing.referenceClose !== null ? String(existing.referenceClose) : "");
      setActiveBranch(existing.activeBranch);
      setNotes(existing.notes ?? "");
    } else {
      setWallPrice("");
      setReferenceClose("");
      setActiveBranch("pending");
      setNotes("");
    }
  }, [existing?.id, symbol]);

  const gapPercent = useMemo(() => {
    const wp = parseFloat(wallPrice);
    const gp = parseFloat(gapPrint);
    if (Number.isNaN(wp) || Number.isNaN(gp) || wp === 0) return null;
    return (gp - wp) / wp;
  }, [wallPrice, gapPrint]);

  const gapTriggersRekey = gapPercent !== null && Math.abs(gapPercent) > GAP_THRESHOLD;

  const blockedStrikes = useMemo(() => {
    const set = new Set<number>();
    (flies ?? [])
      .filter((f) => f.status === "open" && f.symbol === symbol)
      .forEach((f) => {
        set.add(f.lowerStrike);
        set.add(f.middleStrike);
        set.add(f.upperStrike);
      });
    return Array.from(set).sort((a, b) => a - b);
  }, [flies, symbol]);

  const now = new Date();
  const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
  const isThursday = dayName === "Thursday";
  const isFridayAfternoon = dayName === "Friday" && now.getHours() >= 14;

  const handleSaveWall = async () => {
    const wp = parseFloat(wallPrice);
    if (Number.isNaN(wp)) {
      toast({ title: "Wall price required", variant: "destructive" });
      return;
    }
    const payload = {
      symbol,
      weekOf,
      wallPrice: wp,
      referenceClose: referenceClose ? parseFloat(referenceClose) : null,
      activeBranch,
      gapPercent: gapPercent,
      reKeyed: gapTriggersRekey,
      notes: notes || null,
    };
    try {
      if (existing) {
        await updateWall.mutateAsync({ id: existing.id, patch: payload });
      } else {
        await createWall.mutateAsync(payload);
      }
      toast({ title: "Campaign wall saved", description: `${symbol} · week of ${weekOf}` });
    } catch (e: any) {
      toast({ title: "Failed to save wall", description: e.message, variant: "destructive" });
    }
  };

  // --- Duplicate resolution -------------------------------------------------------------
  //
  // The action is deliberately "keep this one" rather than "delete that one": the operator is
  // choosing which wall governs the week, which is the decision they actually hold, and it
  // makes it impossible to click your way to zero walls for an open week.
  const resolveDuplicates = useResolveDuplicateWalls();
  const [pendingKeep, setPendingKeep] = useState<{
    symbol: string;
    weekOf: string;
    keep: CampaignWall;
    discard: CampaignWall[];
  } | null>(null);

  // Flies are shown per row before anything is deleted, because a wall with logged fills
  // against it is not interchangeable with an empty duplicate -- the operator should see
  // which row the week was actually traded under.
  const flyCountByWall = useMemo(() => {
    const counts = new Map<number, number>();
    (flies ?? []).forEach((f) => {
      if (f.campaignWallId === null || f.campaignWallId === undefined) return;
      counts.set(f.campaignWallId, (counts.get(f.campaignWallId) ?? 0) + 1);
    });
    return counts;
  }, [flies]);

  const handleConfirmResolve = async () => {
    if (!pendingKeep) return;
    const { symbol: s, weekOf: w, keep } = pendingKeep;
    try {
      const result = await resolveDuplicates.mutateAsync({ symbol: s, weekOf: w, keepId: keep.id });
      const movedNote =
        result.fliesRepointed > 0
          ? ` ${result.fliesRepointed} logged fl${result.fliesRepointed === 1 ? "y" : "ies"} reattached to it.`
          : "";
      toast({
        title:
          result.deletedIds.length === 0
            ? "Already resolved"
            : `Kept wall #${result.kept.id}, removed ${result.deletedIds.length}`,
        description:
          result.deletedIds.length === 0
            ? `${s} · week of ${w} now has a single wall.`
            : `${s} · week of ${w} · discarded #${result.deletedIds.join(", #")}.${movedNote}`,
      });
      setPendingKeep(null);
    } catch (e: any) {
      // Includes the 409 when the chosen row vanished under a second tab. Left open on
      // purpose so the refreshed list can be re-read and a different row chosen.
      toast({ title: "Could not resolve duplicates", description: e?.message, variant: "destructive" });
    }
  };

  const handleChecklistToggle = (key: keyof ChecklistPatch, value: boolean) => {
    updateChecklist.mutate({ [key]: value });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={symbol} onValueChange={setSymbol}>
          <SelectTrigger className="w-32" data-testid="select-campaign-symbol">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="QQQ">QQQ</SelectItem>
            <SelectItem value="SPY">SPY</SelectItem>
            <SelectItem value="MES">MES</SelectItem>
          </SelectContent>
        </Select>
        <Badge variant="outline" className="font-mono">Week of {weekOf}</Badge>
        {isThursday && <Badge className="bg-chart-4 text-white">Thursday — deploy reserve after expiry crush</Badge>}
        {isFridayAfternoon && <Badge variant="destructive">Friday curfew — exits only</Badge>}
        {currentWeekDuped && (
          <Badge variant="destructive" data-testid="badge-duplicate-wall">
            Duplicate wall keyed for this week
          </Badge>
        )}
      </div>

      {/* Duplicate walls ------------------------------------------------------------------
          Rendered only when there is something to fix, and above the keying form because
          editing a duplicated week is the thing that misleads: the form writes to the
          canonical row while the shadowed rows stay in the book, so the operator should
          collapse the week before touching the branch. */}
      {dupGroups.length > 0 && (
        <div
          className="flex flex-col gap-4 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
          data-testid="panel-duplicate-walls"
        >
          <div>
            <h2 className="text-sm font-semibold text-destructive">
              {dupGroups.length} week{dupGroups.length === 1 ? "" : "s"} keyed more than once
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              A symbol and week should hold exactly one wall. Where there is more than one, the
              engine, the copilot and this page all read the newest row (highest id) and ignore
              the rest — so a branch or price stored on a shadowed row is live in the database and
              dead to every reader. Keep the row that actually governs the week; the others are
              deleted and any fills logged against them are reattached to the row you keep.
            </p>
          </div>

          {dupGroups.map((group) => (
            <div
              key={`${group.symbol}-${group.weekOf}`}
              className="rounded-md border border-border bg-background p-3"
              data-testid={`dup-group-${group.symbol}-${group.weekOf}`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{group.symbol}</span>
                <Badge variant="outline" className="font-mono text-[10px]">week of {group.weekOf}</Badge>
                <Badge variant="outline" className="text-[10px]">{group.rows.length} rows</Badge>
                {group.symbol === symbol && group.weekOf === weekOf && (
                  <Badge className="bg-chart-4 text-[10px] text-white">Current selection</Badge>
                )}
              </div>

              <div className="flex flex-col gap-2">
                {group.rows.map((row) => {
                  const isCanonical = row.id === group.canonical.id;
                  const flyCount = flyCountByWall.get(row.id) ?? 0;
                  return (
                    <div
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2"
                      data-testid={`dup-row-${row.id}`}
                    >
                      <div className="flex flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-mono text-xs text-muted-foreground">#{row.id}</span>
                          <span className="font-mono">{fmtUsd(row.wallPrice)}</span>
                          <Badge variant="outline" className="text-[10px]">{row.activeBranch}</Badge>
                          {row.reKeyed && (
                            <Badge variant="outline" className="text-[10px]">re-keyed</Badge>
                          )}
                          {isCanonical ? (
                            <Badge className="bg-chart-2 text-[10px] text-white">Engine reads this</Badge>
                          ) : (
                            <Badge variant="destructive" className="text-[10px]">Ignored</Badge>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          Ref close {fmtUsd(row.referenceClose)} · gap{" "}
                          {row.gapPercent === null ? "—" : fmtPct(row.gapPercent, 2)} · created{" "}
                          {new Date(row.createdAt).toLocaleString()} ·{" "}
                          {flyCount === 0 ? "no fills logged" : `${flyCount} fill${flyCount === 1 ? "" : "s"} logged`}
                        </div>
                        {row.notes && (
                          <div className="max-w-prose text-[10px] italic text-muted-foreground">{row.notes}</div>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={isCanonical ? "default" : "outline"}
                        disabled={resolveDuplicates.isPending}
                        onClick={() =>
                          setPendingKeep({
                            symbol: group.symbol,
                            weekOf: group.weekOf,
                            keep: row,
                            discard: group.rows.filter((r) => r.id !== row.id),
                          })
                        }
                        data-testid={`button-keep-wall-${row.id}`}
                      >
                        Keep this one
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Irreversible and it removes rows the operator may have typed by hand, so the exact
          rows being discarded — and any fills that move with them — are named before the
          delete, not summarised as a count. */}
      <AlertDialog open={pendingKeep !== null} onOpenChange={(open) => !open && setPendingKeep(null)}>
        <AlertDialogContent data-testid="dialog-resolve-duplicates">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Keep wall #{pendingKeep?.keep.id} for {pendingKeep?.symbol} week of {pendingKeep?.weekOf}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-left">
                <p>
                  Wall #{pendingKeep?.keep.id} at{" "}
                  <span className="font-mono">{fmtUsd(pendingKeep?.keep.wallPrice)}</span> on branch{" "}
                  <span className="font-mono">{pendingKeep?.keep.activeBranch}</span> becomes the only
                  wall for that week.
                </p>
                <p>These rows are deleted permanently:</p>
                <ul className="flex flex-col gap-1">
                  {(pendingKeep?.discard ?? []).map((row) => {
                    const flyCount = flyCountByWall.get(row.id) ?? 0;
                    return (
                      <li key={row.id} className="font-mono text-xs">
                        #{row.id} · {fmtUsd(row.wallPrice)} · {row.activeBranch}
                        {flyCount > 0
                          ? ` · ${flyCount} fill${flyCount === 1 ? "" : "s"} move to #${pendingKeep?.keep.id}`
                          : ""}
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs">This cannot be undone.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-resolve">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Kept open until the request settles so a failure can be read and retried.
                e.preventDefault();
                handleConfirmResolve();
              }}
              disabled={resolveDuplicates.isPending}
              data-testid="button-confirm-resolve"
            >
              {resolveDuplicates.isPending ? "Resolving…" : "Keep and delete the rest"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Wall keying */}
        <div className="flex flex-col gap-4 rounded-lg border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">Key this week's wall</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Wall price</Label>
              <Input data-testid="input-wall-price" type="number" value={wallPrice} onChange={(e) => setWallPrice(e.target.value)} placeholder="e.g. 715" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Reference close</Label>
              <Input data-testid="input-reference-close" type="number" value={referenceClose} onChange={(e) => setReferenceClose(e.target.value)} placeholder="e.g. 711.37" />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Active branch</Label>
            <Select value={activeBranch} onValueChange={setActiveBranch}>
              <SelectTrigger data-testid="select-branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending — not yet resolved</SelectItem>
                {BRANCHES.map((b) => (
                  <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeBranch !== "pending" && (
              <p className="text-xs text-muted-foreground">
                {BRANCHES.find((b) => b.value === activeBranch)?.description}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Notes</Label>
            <Textarea data-testid="input-wall-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>

          <Button onClick={handleSaveWall} disabled={createWall.isPending || updateWall.isPending} data-testid="button-save-wall">
            {existing ? "Update wall" : "Save wall"}
          </Button>

          {/* Gexbot dealer positioning — advisory, with a one-click override so the wall
              can be keyed from the published level instead of typed by hand. */}
          <div className="rounded-md border border-border bg-muted/50 p-3" data-testid="panel-gexbot">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Gexbot dealer positioning
              </h3>
              <div className="flex flex-wrap items-center gap-1">
                {gexStatus && (
                  <Badge variant="outline" className="font-mono text-[10px]" data-testid="badge-gexbot-tier">
                    {gexStatus.tier}
                  </Badge>
                )}
                {gexStatus && (
                  <Badge variant="outline" className="font-mono text-[10px]" data-testid="badge-gexbot-quota">
                    {gexStatus.callsToday} call{gexStatus.callsToday === 1 ? "" : "s"} today
                  </Badge>
                )}
              </div>
            </div>

            {gexStatus && !gexStatus.configured && (
              <p className="text-xs text-destructive" data-testid="text-gexbot-unconfigured">
                No Gexbot key found in the server environment.
              </p>
            )}

            {/* A key stored without the required gexbot_custom_ prefix would otherwise fail
                as an opaque 401, so the normalisation is shown rather than hidden. */}
            {gexStatus?.keyPrefixAdded && (
              <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground" data-testid="text-gexbot-prefix-added">
                The stored key was missing the required <span className="font-mono">gexbot_custom_</span> prefix;
                it is being sent with the prefix added.
              </p>
            )}

            {gexStatus && !gexStatus.symbolCovered && (
              <p className="mb-2 text-xs text-destructive" data-testid="text-gexbot-uncovered">
                {gexStatus.symbol} is not in Gexbot's carried ticker set.
              </p>
            )}

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded border border-border bg-background p-2">
                <div className="text-[10px] uppercase text-muted-foreground">Major +GEX</div>
                <div className="font-mono text-sm" data-testid="text-gex-call-wall">{fmtLevel(gexLevels?.callWall)}</div>
              </div>
              <div className="rounded border border-border bg-background p-2">
                <div className="text-[10px] uppercase text-muted-foreground">Major −GEX</div>
                <div className="font-mono text-sm" data-testid="text-gex-put-wall">{fmtLevel(gexLevels?.putWall)}</div>
              </div>
              <div className="rounded border border-border bg-background p-2">
                <div className="text-[10px] uppercase text-muted-foreground">Zero gamma</div>
                <div className="font-mono text-sm" data-testid="text-gex-gamma-flip">{fmtLevel(gexLevels?.gammaFlip)}</div>
              </div>
            </div>

            {gexLevels?.regime && (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="text-gex-regime">
                Regime: <span className="font-mono">{gexLevels.regime}</span>
                {gexLevels.gammaFlipStatus ? ` · flip ${gexLevels.gammaFlipStatus}` : ""}
                {gexLevels.category ? ` · ${gexLevels.category}` : ""}
              </p>
            )}

            {/* Gexbot documents spot as null when it is not available to the caller, so an
                absent spot is reported as absent rather than rendered as a zero. */}
            {gexLevels && (
              <p className="mt-1 text-[10px] text-muted-foreground" data-testid="text-gex-spot">
                Provider spot: <span className="font-mono">{fmtLevel(gexLevels.spot)}</span>
                {gexLevels.spot === null || gexLevels.spot === undefined
                  ? " (not available on this key)"
                  : ""}
              </p>
            )}

            {gexStatus?.cached?.fetchedAt && (
              <p className="mt-1 text-[10px] text-muted-foreground" data-testid="text-gex-fetched-at">
                Cached {new Date(gexStatus.cached.fetchedAt).toLocaleString()}
              </p>
            )}

            {gexError && (
              <p className="mt-2 text-xs text-destructive" data-testid="text-gex-error">{gexError}</p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => gexRefresh.mutate()}
                disabled={gexRefresh.isPending || !gexStatus?.configured}
                data-testid="button-gex-refresh"
              >
                {gexRefresh.isPending ? "Fetching…" : "Refresh levels"}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const cw = gexLevels?.callWall;
                  // Re-checked here as well as in the disabled state: a stale render or a
                  // keyboard activation must not be able to slip a below-spot wall through.
                  if (cw === null || cw === undefined || overrideGuard.blocked) return;
                  // Written at full published precision. Rounding to a whole strike would
                  // assert this level IS a strike (it is not), and rounding either way shifts
                  // the wall relative to spot, which is the exact quantity every branch is
                  // scored against -- so it would bias branch selection to buy tidiness.
                  setWallPrice(String(cw));
                  const gapNote =
                    overrideGuard.gap !== null
                      ? ` It sits ${overrideGuard.gap.toFixed(2)} above spot.`
                      : "";
                  toast({
                    title: "Wall overridden from Gexbot",
                    description:
                      `Major +GEX ${cw.toFixed(2)} loaded.${gapNote} Press ${existing ? "Update" : "Save"} wall to store it.`,
                  });
                }}
                disabled={overrideGuard.blocked}
                data-testid="button-gex-use-call-wall"
              >
                Use major +GEX
              </Button>
            </div>
            {overrideGuard.reason && (
              <p
                className="mt-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] leading-relaxed text-destructive"
                data-testid="text-gex-override-guard"
              >
                {overrideGuard.reason}
              </p>
            )}

            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
              Advisory only — the keyed wall above remains the number the engine reads. The
              major positive GEX level by open interest is the overhead analogue; it is an
              interpretation of Gexbot's series, which does not label either level a "wall".
              Levels are shown exactly as published and never rounded to a strike — they are
              not strikes.
              Fetched on demand and never by a scheduled job, because /majors draws on the
              small api_majors pool. Open interest is recomputed once daily at 08:30 ET, so
              refreshing more often than that returns the same figures for a spent request.
            </p>
          </div>

          <div className="rounded-md border border-border bg-muted/50 p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Wed-night gap check</h3>
            <div className="flex items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Wednesday-night print</Label>
                <Input data-testid="input-gap-print" type="number" value={gapPrint} onChange={(e) => setGapPrint(e.target.value)} placeholder="e.g. 730" />
              </div>
              {gapPercent !== null && (
                <Badge variant={gapTriggersRekey ? "destructive" : "outline"} className="mb-0.5">
                  {fmtPct(gapPercent, 2)} vs wall
                </Badge>
              )}
            </div>
            {gapTriggersRekey && (
              <p className="mt-2 text-xs text-destructive" data-testid="text-rekey-warning">
                Gap exceeds 2.5% — stand down on planned entries, re-key the map off Thursday's open print.
              </p>
            )}
          </div>
        </div>

        {/* Execution checklist + blocked strikes */}
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-card-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Execution checklist</h2>
            <div className="flex flex-col gap-2.5">
              {CHECKLIST_ITEMS.map((item) => (
                <label key={item.key} className="flex items-center gap-2.5 text-sm">
                  <Checkbox
                    data-testid={`checkbox-${item.key}`}
                    checked={Boolean(checklist?.[item.key])}
                    onCheckedChange={(v) => handleChecklistToggle(item.key, Boolean(v))}
                  />
                  {item.label}
                </label>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Working window 9:45–10:30 AM ET. Start limits at mid, improve $0.05 every 2–3 min, cancel at max-pay.
            </p>
          </div>

          <div className="rounded-lg border border-card-border bg-card p-4">
            <h2 className="mb-2 text-sm font-semibold">Blocked strikes — {symbol}</h2>
            {blockedStrikes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open positions yet this week.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5" data-testid="list-blocked-strikes">
                {blockedStrikes.map((s) => (
                  <Badge key={s} variant="outline" className="font-mono">{s}</Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
