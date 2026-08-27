import { useEffect, useMemo, useState } from "react";
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
