import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./queryClient";
import type {
  Fly,
  InsertFly,
  CampaignWall,
  InsertCampaignWall,
  Settings,
  InsertSettings,
  ExecutionChecklist,
  InsertExecutionChecklist,
  JournalNote,
  InsertJournalNote,
} from "@shared/schema";

export type ChainOption = {
  symbol: string;
  expiration: string;
  type: "call" | "put";
  strike: number;
  bid: number;
  ask: number;
  mid: number;
  last: number | null;
  volume: number;
  openInterest: number;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
};

export type ChainResponse = {
  symbol: string;
  spot: number;
  prevClose: number | null;
  timestamp: string;
  expirations: string[];
  options: ChainOption[];
};

export type QuoteResponse = {
  symbol: string;
  spot: number;
  prevClose: number | null;
  timestamp: string;
};

// ---- Market data ----
export function useChain(symbol: string, enabled = true) {
  return useQuery<ChainResponse>({
    queryKey: [`/api/chain/${symbol}`],
    enabled,
    refetchInterval: 15_000,
  });
}

export function useQuote(symbol: string, enabled = true) {
  return useQuery<QuoteResponse>({
    queryKey: [`/api/quote/${symbol}`],
    enabled,
    refetchInterval: 15_000,
  });
}

export type FlyPriceResponse = {
  source: "ibkr" | "cboe" | "unavailable";
  multiplier: number;
  spot: number | null;
  timestamp: string;
  midDebit: number | null;
  worstDebit: number | null;
  maxLossMid: number | null;
  maxLossWorst: number | null;
  maxProfit: number | null;
  breakevenLower: number | null;
  breakevenUpper: number | null;
  rewardToRiskMid: number | null;
  isBrokenWing: boolean;
  lowerWingWidth: number;
  upperWingWidth: number;
};

export type FlyPriceParams = {
  symbol: string;
  optionType: "call" | "put";
  expiration: string;
  lower: number;
  middle: number;
  upper: number;
  contracts: number;
};

// Live-first fly pricing: tries the connected IBKR account for QQQ/SPY, falls back
// to the delayed Cboe chain, reports "unavailable" otherwise (e.g. MES).
export function useFlyPrice(params: FlyPriceParams | null, enabled = true) {
  const search = params
    ? new URLSearchParams({
        optionType: params.optionType,
        expiration: params.expiration,
        lower: String(params.lower),
        middle: String(params.middle),
        upper: String(params.upper),
        contracts: String(params.contracts),
      }).toString()
    : "";
  const url = params ? `/api/fly-price/${params.symbol}?${search}` : "";
  return useQuery<FlyPriceResponse>({
    queryKey: [url],
    enabled: enabled && !!params,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

// ---- Flies ----
export function useFlies() {
  return useQuery<Fly[]>({ queryKey: ["/api/flies"] });
}

// Live-first pricing for a whole list of flies at once (used by the Cockpit dials/meters).
// Wraps useQueries so the hook count stays stable regardless of how many positions are open.
export function useFliesLivePricing(flies: Fly[]) {
  return useQueries({
    queries: flies.map((f) => {
      const search = new URLSearchParams({
        optionType: f.optionType,
        expiration: f.expiration,
        lower: String(f.lowerStrike),
        middle: String(f.middleStrike),
        upper: String(f.upperStrike),
        contracts: String(f.contracts),
      }).toString();
      const url = `/api/fly-price/${f.symbol}?${search}`;
      return {
        queryKey: [url],
        refetchInterval: 10_000 as const,
        staleTime: 5_000,
      };
    }),
  });
}

// Live spot quotes for a set of symbols (used to gauge distance-to-wall per position).
export function useQuotesFor(symbols: string[]) {
  return useQueries({
    queries: symbols.map((s) => ({
      queryKey: [`/api/quote/${s}`],
      refetchInterval: 15_000 as const,
    })),
  });
}

export function useCreateFly() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fly: InsertFly) => {
      const res = await apiRequest("POST", "/api/flies", fly);
      return (await res.json()) as Fly;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/flies"] }),
  });
}

export function useUpdateFly() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Partial<InsertFly> }) => {
      const res = await apiRequest("PATCH", `/api/flies/${id}`, patch);
      return (await res.json()) as Fly;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/flies"] }),
  });
}

export function useDeleteFly() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/flies/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/flies"] }),
  });
}

// Reports a freshly-computed unrealized P&L extreme for an OPEN fly (as a fraction of
// maxProfit / maxLoss). The server only ratchets peakProfitPct up / peakLossPct down—
// safe to call repeatedly with the same or a worse value. Invalidates the flies list so
// the Journal's threshold-review panel reflects the latest peak without a manual refresh.
export function useTrackFlyExtreme() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, profitPct, lossPct }: { id: number; profitPct: number; lossPct: number }) => {
      const res = await apiRequest("POST", `/api/flies/${id}/track-extreme`, { profitPct, lossPct });
      return (await res.json()) as Fly;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/flies"] }),
  });
}

// ---- Campaign walls ----
export function useCampaignWalls() {
  return useQuery<CampaignWall[]>({ queryKey: ["/api/campaign"] });
}

export function useCreateCampaignWall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (wall: InsertCampaignWall) => {
      const res = await apiRequest("POST", "/api/campaign", wall);
      return (await res.json()) as CampaignWall;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/campaign"] }),
  });
}

export function useUpdateCampaignWall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Partial<InsertCampaignWall> }) => {
      const res = await apiRequest("PATCH", `/api/campaign/${id}`, patch);
      return (await res.json()) as CampaignWall;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/campaign"] }),
  });
}

export function useDeleteCampaignWall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/campaign/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/campaign"] }),
  });
}

// ---- Settings ----
export function useSettings() {
  return useQuery<Settings>({ queryKey: ["/api/settings"] });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<InsertSettings>) => {
      const res = await apiRequest("PUT", "/api/settings", patch);
      return (await res.json()) as Settings;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/settings"] }),
  });
}

// ---- Checklist ----
export function useChecklist(weekOf: string) {
  return useQuery<ExecutionChecklist | null>({ queryKey: [`/api/checklist/${weekOf}`] });
}

export function useUpdateChecklist(weekOf: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<InsertExecutionChecklist>) => {
      const res = await apiRequest("PUT", `/api/checklist/${weekOf}`, patch);
      return (await res.json()) as ExecutionChecklist;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/checklist/${weekOf}`] }),
  });
}

// ---- Journal notes (freeform desk log) ----
export function useJournalNotes() {
  return useQuery<JournalNote[]>({ queryKey: ["/api/journal-notes"] });
}

export function useCreateJournalNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (note: InsertJournalNote) => {
      const res = await apiRequest("POST", "/api/journal-notes", note);
      return (await res.json()) as JournalNote;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/journal-notes"] }),
  });
}
