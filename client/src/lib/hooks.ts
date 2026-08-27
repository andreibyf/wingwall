import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./queryClient";
import type { Fly, InsertFly, CampaignWall, InsertCampaignWall, Settings, InsertSettings, ExecutionChecklist, InsertExecutionChecklist } from "@shared/schema";

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

// ---- Flies ----
export function useFlies() {
  return useQuery<Fly[]>({ queryKey: ["/api/flies"] });
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
