import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  useCampaignWalls,
  useCreateCampaignWall,
  useUpdateCampaignWall,
  useFlies,
  useChecklist,
  useUpdateChecklist,
} from "@/lib/hooks";
import { fmtUsd, fmtPct, weekOfMonday } from "@/lib/format";
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

// Gexbot publishes the major positive/negative GEX strikes by open interest and the
// zero-gamma line. Wingwall's wall is an OVERHEAD level, so the major POSITIVE strike is
// the wall analogue; the major negative strike is the downside acceleration band. The keyed
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

  const existing = useMemo(
    () => (walls ?? []).find((w) => w.symbol === symbol && w.weekOf === weekOf),
    [walls, symbol, weekOf]
  );

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
      </div>

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
                  if (cw === null || cw === undefined) return;
                  setWallPrice(String(cw));
                  toast({
                    title: "Wall overridden from Gexbot",
                    description: `Major +GEX ${cw.toFixed(2)} loaded — press ${existing ? "Update" : "Save"} wall to store it.`,
                  });
                }}
                disabled={gexLevels?.callWall === null || gexLevels?.callWall === undefined}
                data-testid="button-gex-use-call-wall"
              >
                Use major +GEX
              </Button>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
              Advisory only — the keyed wall above remains the number the engine reads. The
              major positive GEX strike by open interest is the overhead analogue; it is an
              interpretation of Gexbot's series, which does not label either level a "wall".
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
