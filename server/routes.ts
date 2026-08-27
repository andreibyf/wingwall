import type { Express } from "express";
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { storage } from "./storage";
import {
  insertFlySchema,
  insertCampaignWallSchema,
  insertSettingsSchema,
  insertExecutionChecklistSchema,
} from "@shared/schema";
import { computeFlyPricing, getMultiplier, type ChainLeg } from "@shared/flyMath";
import { getIbkrFlyQuote, isIbkrSupported, IbkrPricingError } from "./ibkr";

const CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const SUPPORTED_SYMBOLS = new Set(["QQQ", "SPY"]);

type CacheEntry = { data: any; ts: number };
const chainCache = new Map<string, CacheEntry>();
const CACHE_MS = 15_000;

async function fetchCboe(symbol: string): Promise<any> {
  const url = `${CBOE_BASE}/${symbol}.json`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Upstream error ${res.status}`), { status: res.status === 403 ? 502 : res.status });
  }
  return res.json();
}

function parseOccSymbol(occ: string, root: string) {
  // e.g. QQQ260826C00495000 -> root QQQ, exp 26-08-26, C, strike 495.00
  const rest = occ.slice(root.length);
  const yy = rest.slice(0, 2);
  const mm = rest.slice(2, 4);
  const dd = rest.slice(4, 6);
  const cp = rest.slice(6, 7);
  const strikeRaw = rest.slice(7);
  const strike = parseInt(strikeRaw, 10) / 1000;
  const expiration = `20${yy}-${mm}-${dd}`;
  return { expiration, type: cp === "C" ? "call" : "put", strike };
}

async function getChain(symbol: string) {
  const cached = chainCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.data;

  const raw = await fetchCboe(symbol);
  const underlying = raw?.data ?? {};
  const options = Array.isArray(underlying?.options) ? underlying.options : [];
  const spot = underlying.current_price ?? underlying.close ?? underlying.prev_day_close ?? 0;

  const lowBound = spot * 0.8;
  const highBound = spot * 1.2;
  const today = new Date();
  const maxExpiry = new Date(today.getTime() + 75 * 24 * 60 * 60 * 1000); // ~11 weeks out

  const parsed = options
    .map((o: any) => {
      const meta = parseOccSymbol(o.option as string, symbol);
      return { ...meta, raw: o };
    })
    .filter((o: any) => {
      const expDate = new Date(o.expiration + "T00:00:00Z");
      return o.strike >= lowBound && o.strike <= highBound && expDate <= maxExpiry;
    })
    .map((o: any) => {
      const bid = o.raw.bid ?? 0;
      const ask = o.raw.ask ?? 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : o.raw.theo ?? o.raw.last_trade_price ?? 0;
      return {
        symbol: o.raw.option,
        expiration: o.expiration,
        type: o.type,
        strike: o.strike,
        bid,
        ask,
        mid: Number(mid.toFixed(4)),
        last: o.raw.last_trade_price ?? null,
        volume: o.raw.volume ?? 0,
        openInterest: o.raw.open_interest ?? 0,
        iv: o.raw.iv ?? null,
        delta: o.raw.delta ?? null,
        gamma: o.raw.gamma ?? null,
        theta: o.raw.theta ?? null,
        vega: o.raw.vega ?? null,
      };
    });

  const expirations = Array.from(new Set(parsed.map((p: any) => p.expiration))).sort();

  const result = {
    symbol,
    spot,
    prevClose: underlying.prev_day_close ?? underlying.close ?? null,
    timestamp: raw.timestamp ?? new Date().toISOString(),
    expirations,
    options: parsed,
  };

  chainCache.set(symbol, { data: result, ts: Date.now() });
  return result;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // ---- Live fly pricing (IBKR-first, Cboe fallback) ----
  // Fetches real-time bid/ask for exactly the 3 legs of a fly — not a full chain.
  // QQQ/SPY try the connected IBKR account first (real-time SMART-routed equity
  // options); if that fails for any reason (not connected, expiration/strikes not
  // found, no live quote) it falls back to the same delayed Cboe chain used
  // elsewhere in the app. Symbols outside QQQ/SPY (e.g. MES, which has no CME
  // real-time data on this IBKR account) report source "unavailable".
  app.get("/api/fly-price/:symbol", async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const optionType = req.query.optionType === "put" ? "put" : "call";
      const expiration = String(req.query.expiration ?? "");
      const lowerStrike = Number(req.query.lower);
      const middleStrike = Number(req.query.middle);
      const upperStrike = Number(req.query.upper);
      const contracts = Number(req.query.contracts) || 1;

      if (!expiration || [lowerStrike, middleStrike, upperStrike].some((n) => Number.isNaN(n))) {
        return res.status(400).json({ message: "expiration, lower, middle, upper are required" });
      }

      const legs = { optionType, lowerStrike, middleStrike, upperStrike, contracts } as const;
      const multiplier = getMultiplier(symbol);

      if (isIbkrSupported(symbol)) {
        try {
          const quote = await getIbkrFlyQuote(symbol, expiration, optionType, lowerStrike, middleStrike, upperStrike);
          const pricing = computeFlyPricing(legs, [quote.lowerLeg, quote.middleLeg, quote.upperLeg], multiplier);
          return res.json({ source: "ibkr", multiplier, spot: quote.spot, timestamp: new Date().toISOString(), ...pricing });
        } catch (err) {
          if (!(err instanceof IbkrPricingError)) console.error("IBKR pricing error:", err);
          // fall through to Cboe fallback below
        }
      }

      if (SUPPORTED_SYMBOLS.has(symbol)) {
        try {
          const chain = await getChain(symbol);
          const chainLegs: ChainLeg[] = chain.options.filter((o: any) => o.expiration === expiration);
          const pricing = computeFlyPricing(legs, chainLegs, multiplier);
          if (pricing.midDebit !== null) {
            return res.json({ source: "cboe", multiplier, spot: chain.spot, timestamp: chain.timestamp, ...pricing });
          }
        } catch {
          // fall through to unavailable below
        }
      }

      return res.json({
        source: "unavailable",
        multiplier,
        spot: null,
        timestamp: new Date().toISOString(),
        midDebit: null,
        worstDebit: null,
        maxLossMid: null,
        maxLossWorst: null,
        maxProfit: null,
        breakevenLower: null,
        breakevenUpper: null,
        rewardToRiskMid: null,
        isBrokenWing: Math.abs((middleStrike - lowerStrike) - (upperStrike - middleStrike)) > 0.001,
        lowerWingWidth: middleStrike - lowerStrike,
        upperWingWidth: upperStrike - middleStrike,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Market data (Cboe proxy) ----
  app.get("/api/quote/:symbol", async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      if (!SUPPORTED_SYMBOLS.has(symbol)) {
        return res.status(400).json({ message: `No free live feed available for ${symbol}. Supported: QQQ, SPY.` });
      }
      const chain = await getChain(symbol);
      res.json({
        symbol: chain.symbol,
        spot: chain.spot,
        prevClose: chain.prevClose,
        timestamp: chain.timestamp,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/chain/:symbol", async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      if (!SUPPORTED_SYMBOLS.has(symbol)) {
        return res.status(400).json({ message: `No free live options chain available for ${symbol}. Supported: QQQ, SPY.` });
      }
      const chain = await getChain(symbol);
      res.json(chain);
    } catch (err) {
      next(err);
    }
  });

  // ---- Flies (journal + builder positions) ----
  app.get("/api/flies", async (_req, res, next) => {
    try {
      res.json(await storage.listFlies());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/flies", async (req, res, next) => {
    try {
      const parsed = insertFlySchema.parse(req.body);
      res.status(201).json(await storage.createFly(parsed));
    } catch (err) {
      next(err);
    }
  });

  app.patch("/api/flies/:id", async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const parsed = insertFlySchema.partial().parse(req.body);
      const updated = await storage.updateFly(id, parsed);
      if (!updated) return res.status(404).json({ message: "Fly not found" });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/flies/:id", async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      await storage.deleteFly(id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ---- Campaign walls ----
  app.get("/api/campaign", async (_req, res, next) => {
    try {
      res.json(await storage.listCampaignWalls());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/campaign", async (req, res, next) => {
    try {
      const parsed = insertCampaignWallSchema.parse(req.body);
      res.status(201).json(await storage.createCampaignWall(parsed));
    } catch (err) {
      next(err);
    }
  });

  app.patch("/api/campaign/:id", async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const parsed = insertCampaignWallSchema.partial().parse(req.body);
      const updated = await storage.updateCampaignWall(id, parsed);
      if (!updated) return res.status(404).json({ message: "Campaign wall not found" });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/campaign/:id", async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      await storage.deleteCampaignWall(id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ---- Execution checklist ----
  app.get("/api/checklist/:weekOf", async (req, res, next) => {
    try {
      const row = await storage.getChecklist(req.params.weekOf);
      res.json(row ?? null);
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/checklist/:weekOf", async (req, res, next) => {
    try {
      const parsed = insertExecutionChecklistSchema.partial().parse(req.body);
      res.json(await storage.upsertChecklist(req.params.weekOf, parsed));
    } catch (err) {
      next(err);
    }
  });

  // ---- Settings ----
  app.get("/api/settings", async (_req, res, next) => {
    try {
      res.json(await storage.getSettings());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/settings", async (req, res, next) => {
    try {
      const parsed = insertSettingsSchema.partial().parse(req.body);
      res.json(await storage.updateSettings(parsed));
    } catch (err) {
      next(err);
    }
  });

  return httpServer;
}
