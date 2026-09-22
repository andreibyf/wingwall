import type { Express } from "express";
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import {
  storage,
  getGexCallsToday,
  recordGexCall,
  getCachedLevels,
  putCachedLevels,
  etDateKey,
} from "./storage";
import {
  getLevels as gexGetLevels,
  resolveKey as gexResolveKey,
  resolveTier as gexResolveTier,
  isCovered as gexIsCovered,
  isValidCategory as gexIsValidCategory,
  DEFAULT_CATEGORY as GEX_DEFAULT_CATEGORY,
  type ClassicCategory,
} from "./gexbot";
import {
  insertFlySchema,
  insertCampaignWallSchema,
  insertSettingsSchema,
  insertExecutionChecklistSchema,
  insertJournalNoteSchema,
} from "@shared/schema";
import { computeFlyPricing, getMultiplier, type ChainLeg } from "@shared/flyMath";
import { z } from "zod";
import { runAutoTrade, tradingWeek } from "./auto-trade";
import { freshQuote } from "./automation-policy";
import {paperMode,setAutomationMode} from "./automation-control";
import { workerStatus } from "./paper-worker";
import { registerStrategyRoutes } from "./strategy-store";
import {registerChecklistEvidence} from "./checklist-evidence";
import {registerDraftRoutes,saveRecommendationDraft,draftForRequest} from "./recommendation-drafts";
import { resolveExitPolicy, assessThresholdReachability } from "@shared/exit-policy";
import { getIbkrFlyQuote, isIbkrSupported, IbkrPricingError } from "./ibkr";
import {
  buildSignalSnapshot,
  runCopilotChat,
  isCopilotConfigured,
  listCopilotModels,
  copilotModel,
  copilotChatPolicy,
  describeApiKeyShape,
  type ChatMessage,
} from "./copilot";

const CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const SUPPORTED_SYMBOLS = new Set(["QQQ", "SPY"]);

type CacheEntry = { data: any; ts: number };
const chainCache = new Map<string, CacheEntry>();
const CACHE_MS = 15_000;

async function fetchCboe(symbol: string): Promise<any> {
  const url = `${CBOE_BASE}/${symbol}.json`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
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

export async function getChain(symbol: string) {
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
    timestamp: raw.timestamp ?? "",
    expirations,
    options: parsed,
  };

  chainCache.set(symbol, { data: result, ts: Date.now() });
  return result;
}

// Shared IBKR-first, Cboe-fallback pricing lookup for one fly's 3 legs. Used by both
// the interactive /api/fly-price route and the server-side peak-tracking job below, so
// tracked peaks always reflect the exact same pricing logic the UI displays.
// In production (RENDER=true, no `external-tool` CLI / IBKR connector available), IBKR
// is skipped entirely so every request goes straight to Cboe without wasted retries.
const IBKR_AVAILABLE = process.env.RENDER !== "true" && process.env.DISABLE_IBKR !== "true";

export async function getFlyLivePricing(
  symbol: string,
  optionType: "call" | "put",
  expiration: string,
  lowerStrike: number,
  middleStrike: number,
  upperStrike: number,
  contracts: number,
) {
  const legs = { optionType, lowerStrike, middleStrike, upperStrike, contracts } as const;
  const multiplier = getMultiplier(symbol);

  if (IBKR_AVAILABLE && isIbkrSupported(symbol)) {
    try {
      const quote = await getIbkrFlyQuote(symbol, expiration, optionType, lowerStrike, middleStrike, upperStrike);
      const pricing = computeFlyPricing(legs, [quote.lowerLeg, quote.middleLeg, quote.upperLeg], multiplier);
      // Connector does not expose a verified provider timestamp. Display is allowed,
      // but an automated write must not treat retrieval time as quote time.
      return { source: "ibkr", multiplier, spot: quote.spot, timestamp: "", ...pricing };
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
        return { source: "cboe", multiplier, spot: chain.spot, timestamp: chain.timestamp, ...pricing };
      }
    } catch {
      // fall through to unavailable below
    }
  }

  return {
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
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  registerStrategyRoutes(app);
  registerChecklistEvidence(app,getChain);
  app.get("/api/automation/status",async(_req,res,next)=>{
    try {res.json(await workerStatus());} catch(err){next(err);}
  });
  app.put("/api/automation/mode",async(req,res,next)=>{
    try {
      const input=z.object({mode:z.enum(["observe","paper"]),version:z.number().int().positive(),acknowledge:z.literal(true)}).strict().parse(req.body);
      if(input.mode==="paper") {
        const status=await workerStatus();
        if(!status.healthy||!status.operatorConfigured)return res.status(409).json({message:"Paper mode requires a healthy worker and operator authentication. No settings changed."});
      }
      const control=await setAutomationMode(input.mode,input.version);
      res.json({...control,entryArmed:false,message:"Mode saved. New entries are off. Drafts remain non-executable."});
    }catch(err){next(err);}
  });
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

      const pricing = await getFlyLivePricing(symbol, optionType, expiration, lowerStrike, middleStrike, upperStrike, contracts);
      res.json(pricing);
    } catch (err) {
      next(err);
    }
  });

  // ---- Server-side peak tracking (for the Render cron job) ----
  // Loops every open fly, prices it via the same IBKR/Cboe fallback logic as the UI,
  // and ratchets peakProfitPct/peakLossPct. This is what makes threshold tracking run
  // 24/7 instead of only while a browser tab has the dashboard open. Protected by a
  // shared-secret header since it's a public write endpoint hit on a schedule.
  app.post("/api/track-all-open-peaks", async (req, res, next) => {
    try {
      const secret = process.env.CRON_SECRET;
      if (!secret || secret.length<16 || req.header("x-cron-secret") !== secret) {
        return res.status(401).json({ message: "unauthorized" });
      }
      const openFlies = (await storage.listFlies()).filter((f) => f.status === "open");
      const results: any[] = [];
      for (const fly of openFlies) {
        try {
          const pricing = await getFlyLivePricing(
            fly.symbol,
            fly.optionType as "call" | "put",
            fly.expiration,
            fly.lowerStrike,
            fly.middleStrike,
            fly.upperStrike,
            fly.contracts,
          );
          if (pricing.midDebit === null || pricing.midDebit === undefined) {
            results.push({ id: fly.id, skipped: true, reason: pricing.source });
            continue;
          }
          if (!freshQuote(pricing.timestamp)) {
            results.push({id:fly.id,skipped:true,reason:"Quote timestamp missing or stale"});
            continue;
          }
          const multiplier = getMultiplier(fly.symbol);
          const pnl = (pricing.midDebit - fly.entryDebit) * multiplier * fly.contracts;
          const profitPct = pnl / fly.maxProfit;
          const lossPct = pnl / fly.maxLoss;
          const updated = await storage.trackFlyExtreme(fly.id, profitPct, lossPct);
          results.push({
            id: fly.id,
            source: pricing.source,
            peakProfitPct: updated?.peakProfitPct,
            peakLossPct: updated?.peakLossPct,
          });
        } catch (err) {
          results.push({ id: fly.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const degraded=results.some(r=>r.error || r.skipped);
      res.status(degraded?503:200).json({ checked: openFlies.length, degraded, results });
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

  // Called by the client whenever it computes a fresh unrealized P&L for an OPEN fly.
  // Ratchets peakProfitPct up / peakLossPct down; no-op once the fly is closed.
  // profitPct/lossPct are fractions of maxProfit/maxLoss respectively (e.g. 0.25 = 25%).
  app.post("/api/flies/:id/track-extreme", async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const profitPct = Number(req.body?.profitPct);
      const lossPct = Number(req.body?.lossPct);
      if (Number.isNaN(profitPct) || Number.isNaN(lossPct)) {
        return res.status(400).json({ message: "profitPct and lossPct (numbers) are required" });
      }
      const updated = await storage.trackFlyExtreme(id, profitPct, lossPct);
      if (!updated) return res.status(404).json({ message: "Fly not found" });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // ---- Campaign walls ----
  app.post("/api/campaign/resolve-duplicates", async (req, res, next) => {
    const parsed = z.object({
      keepId: z.number().int().positive(),
      duplicateIds: z.array(z.number().int().positive()).min(1),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Select a wall and its duplicates" });
    const { keepId, duplicateIds } = parsed.data;
    if (duplicateIds.includes(keepId) || new Set(duplicateIds).size !== duplicateIds.length) {
      return res.status(400).json({ message: "Invalid duplicate wall selection" });
    }
    try {
      if (!await storage.resolveCampaignWalls(keepId, duplicateIds)) {
        return res.status(409).json({ message: "Walls changed. Refresh and review the duplicates again." });
      }
      res.json({ keepId, removed: duplicateIds.length });
    } catch (err) {
      next(err);
    }
  });

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

  // ---- Gexbot dealer positioning ------------------------------------------------
  //
  // Read-only status. Deliberately makes NO network call: this is what the Campaign page
  // loads on mount, and /majors draws on the small api_majors pool. Everything here comes
  // from the environment and the local cache.
  app.get("/api/gexbot/status", async (_req, res, next) => {
    try {
      const { key, envName, prefixAdded } = gexResolveKey();
      const settings = await storage.getSettings();
      const symbol = settings.defaultSymbol;
      const [callsToday, cached] = await Promise.all([
        getGexCallsToday(),
        getCachedLevels(symbol),
      ]);
      res.json({
        configured: Boolean(key),
        envVarName: envName,
        // Surfaced so a key stored without the required gexbot_custom_ prefix is visible
        // in the UI as a normalisation rather than showing up later as an opaque 401.
        keyPrefixAdded: prefixAdded,
        tier: gexResolveTier(),
        symbol,
        symbolCovered: gexIsCovered(symbol),
        category: GEX_DEFAULT_CATEGORY,
        callsToday,
        quotaPool: "api_majors",
        quotaResetsAt: "midnight ET",
        etDate: etDateKey(),
        refreshedDailyAt: "08:30 ET",
        cached,
      });
    } catch (err) {
      next(err);
    }
  });

  // Explicit, operator-initiated refresh. Never call this from a scheduled job -- the exit
  // watch alone fires eight times a session and would drain api_majors before the first
  // hour closed. Spends exactly ONE request: Gexbot publishes no account endpoint, so there
  // is no entitlement lookup to pay for, and coverage is checked locally before the call.
  app.post("/api/gexbot/refresh", async (req, res, next) => {
    try {
      const settings = await storage.getSettings();
      const symbol = String(req.body?.symbol ?? settings.defaultSymbol).toUpperCase();
      if (!SUPPORTED_SYMBOLS.has(symbol)) {
        return res.status(400).json({ message: `Unsupported symbol: ${symbol}` });
      }

      // Category is overridable so the operator can look at 0DTE/1DTE aggregations, but it
      // is validated against the published set rather than passed through: the Gexbot web
      // app uses different names in its URL hashes (90d, latest, next) and those are not
      // API categories. Forwarding one would spend a request to earn a 400.
      const rawCategory = req.body?.category;
      let category: ClassicCategory = GEX_DEFAULT_CATEGORY;
      if (rawCategory !== undefined && rawCategory !== null && rawCategory !== "") {
        const c = String(rawCategory);
        if (!gexIsValidCategory(c)) {
          return res.status(400).json({ message: `Unsupported Gexbot category: ${c}` });
        }
        category = c;
      }

      const { key } = gexResolveKey();
      if (!key) {
        return res.status(200).json({
          ok: false,
          reason: "no_key",
          detail: "No Gexbot key found in the server environment.",
          callsToday: await getGexCallsToday(),
        });
      }

      // Coverage guard before spending anything. A 404 from Gexbot cannot distinguish an
      // uncarried ticker from a malformed path, so checking locally keeps the diagnosis
      // honest and costs no quota.
      if (!gexIsCovered(symbol)) {
        return res.json({
          ok: false,
          reason: "not_covered",
          detail:
            `${symbol} is not in Gexbot's carried ticker set, so the request was not sent ` +
            `and cost no api_majors quota.`,
          tier: gexResolveTier(),
          callsToday: await getGexCallsToday(),
        });
      }

      const levels = await gexGetLevels(symbol, category);
      // Recorded unconditionally on a sent request. A 429 or a 500 still consumed the
      // attempt as far as the provider's counter is concerned, and a ledger that only
      // counted successes would drift optimistic exactly when the budget is tightest.
      await recordGexCall();
      if (!levels.ok) {
        return res.json({
          ...levels,
          tier: gexResolveTier(),
          category,
          callsToday: await getGexCallsToday(),
        });
      }

      const fetchedAt = new Date().toISOString();
      await putCachedLevels({ ...levels.value, category }, fetchedAt);

      res.json({
        ok: true,
        tier: gexResolveTier(),
        category,
        callsToday: await getGexCallsToday(),
        levels: { ...levels.value, raw: undefined, fetchedAt },
      });
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

  // Bounded, because these fields now drive automation that runs unattended. The schema
  // generated from the table only constrains types, so a mistyped stop of 40 instead of
  // -0.4 would have been stored happily and then compared against a P&L fraction that can
  // never reach it, quietly disabling the stop on every position. Each bound below is the
  // range in which the value has a defined meaning, not a matter of taste.
  const settingsBoundsSchema = z
    .object({
      accountBalance: z.number().positive().max(100_000_000),
      riskPerTradePercent: z.number().positive().max(100),
      defaultSymbol: z.enum(["QQQ", "SPY"]),
      takeProfitMode: z.enum(["multipleOfDebit", "pctOfMaxProfit"]),
      // A multiple at or below 1.0 exits at or below cost; a fraction of max profit above
      // 1.0 is unreachable by definition. One field, two modes, so the useful floor is
      // "greater than zero" and the mode-specific check follows in superRefine.
      takeProfitValue: z.number().positive().max(20),
      // Must be negative: it is compared against a signed loss fraction, so a positive
      // value can never trigger.
      stopLossPctOfMaxLoss: z.number().min(-1).max(-0.01),
      targetDebitToWidth: z.number().positive().max(0.5),
      maxDebitToWidth: z.number().positive().max(0.9),
      autoTradeEnabled: z.boolean(),
    })
    .partial()
    .superRefine((val, ctx) => {
      if (val.takeProfitMode === "multipleOfDebit" && val.takeProfitValue !== undefined && val.takeProfitValue <= 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["takeProfitValue"],
          message: "A debit multiple must exceed 1.0, or the target sits at or below what was paid.",
        });
      }
      if (val.takeProfitMode === "pctOfMaxProfit" && val.takeProfitValue !== undefined && val.takeProfitValue > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["takeProfitValue"],
          message: "A fraction of max profit cannot exceed 1.0.",
        });
      }
      if (
        val.targetDebitToWidth !== undefined &&
        val.maxDebitToWidth !== undefined &&
        val.targetDebitToWidth > val.maxDebitToWidth
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targetDebitToWidth"],
          message: "The target debit-to-width cannot exceed the ceiling.",
        });
      }
    });

  app.put("/api/settings", async (req, res, next) => {
    try {
      const typed = insertSettingsSchema.partial().parse(req.body);
      if(typed.autoTradeEnabled===true) {
        const status=await workerStatus();
        if(await paperMode()!=="paper" || !status.healthy || !status.operatorConfigured) {
          return res.status(409).json({message:"Entry cannot be armed until paper-write mode, operator authentication, and a healthy worker are verified."});
        }
      }
      // Cross-field checks need the stored mode when the client sends only a value.
      const current = await storage.getSettings();
      const merged = { ...typed } as Record<string, unknown>;
      if (merged.takeProfitValue !== undefined && merged.takeProfitMode === undefined) {
        merged.takeProfitMode = current?.takeProfitMode ?? "multipleOfDebit";
      }
      if (merged.targetDebitToWidth !== undefined && merged.maxDebitToWidth === undefined) {
        merged.maxDebitToWidth = current?.maxDebitToWidth ?? 0.15;
      }
      settingsBoundsSchema.parse(merged);
      res.json(await storage.updateSettings(typed));
    } catch (err) {
      next(err);
    }
  });

  // ---- Exit check ----
  // The scheduled exit watch used to restate the threshold arithmetic in its own prompt
  // prose, which meant the rule existed in two places that could disagree -- and did: the
  // prompt still said 25% of max profit after the policy moved to a debit multiple. This
  // endpoint is now the single evaluator. The scheduled job reads `fires` and acts; it
  // performs no arithmetic of its own and cannot apply a policy the app is not configured
  // for.
  app.get("/api/exit-check", async (_req, res, next) => {
    try {
      const [settings, allFlies] = await Promise.all([storage.getSettings(), storage.listFlies()]);
      const policy = resolveExitPolicy({
        takeProfitMode: settings?.takeProfitMode ?? "multipleOfDebit",
        takeProfitValue: settings?.takeProfitValue ?? 2.0,
        stopLossPctOfMaxLoss: settings?.stopLossPctOfMaxLoss ?? -0.4,
      });
      const open = allFlies.filter((f) => f.status === "open");

      const today = new Date().toISOString().slice(0, 10);
      const positions = await Promise.all(
        open.map(async (fly) => {
          const dte = Math.round(
            (new Date(`${fly.expiration}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) /
              86_400_000,
          );
          let pricing: any = null;
          let pricingError: string | null = null;
          try {
            pricing = await getFlyLivePricing(
              fly.symbol,
              fly.optionType as "call" | "put",
              fly.expiration,
              fly.lowerStrike,
              fly.middleStrike,
              fly.upperStrike,
              fly.contracts,
            );
          } catch (err) {
            pricingError = (err as Error).message;
          }

          const mid = pricing?.midDebit;
          if (!Number.isFinite(mid) || mid < 0 || !freshQuote(pricing?.timestamp)) {
            return {
              id: fly.id,
              symbol: fly.symbol,
              optionType: fly.optionType,
              strikes: `${fly.lowerStrike}/${fly.middleStrike}/${fly.upperStrike}`,
              expiration: fly.expiration,
              contracts: fly.contracts,
              entryDebit: fly.entryDebit,
              dte,
              priced: false,
              reason: pricingError ?? "Quote unavailable, stale, or missing a timezone-qualified timestamp",
              // Explicit so an unpriceable position can never be read as "no exit needed".
              fires: null,
            };
          }

          const multiplier = getMultiplier(fly.symbol);
          const pnl = (mid - fly.entryDebit) * multiplier * fly.contracts;
          const profitPct = fly.maxProfit ? pnl / fly.maxProfit : 0;
          const lossPct = fly.maxLoss ? pnl / fly.maxLoss : 0;
          const takeProfitFires =
            policy.takeProfitMode === "multipleOfDebit"
              ? fly.entryDebit > 0 && mid >= fly.entryDebit * policy.takeProfitValue
              : profitPct >= policy.takeProfitValue;
          const stopLossFires = lossPct <= policy.stopLossPctOfMaxLoss;

          return {
            id: fly.id,
            symbol: fly.symbol,
            optionType: fly.optionType,
            strikes: `${fly.lowerStrike}/${fly.middleStrike}/${fly.upperStrike}`,
            expiration: fly.expiration,
            contracts: fly.contracts,
            entryDebit: fly.entryDebit,
            dte,
            priced: true,
            source: pricing.source,
            quoteTimestamp: pricing.timestamp,
            spot: pricing.spot,
            midDebit: Math.round(mid * 100) / 100,
            unrealizedPnl: Math.round(pnl * 100) / 100,
            profitPctOfMaxProfit: Math.round(profitPct * 10000) / 10000,
            lossPctOfMaxLoss: Math.round(lossPct * 10000) / 10000,
            takeProfitFires,
            stopLossFires,
            reachability: assessThresholdReachability(
              policy,
              fly.entryDebit,
              fly.maxProfit,
              fly.maxLoss,
              fly.contracts,
              multiplier,
              fly.peakProfitPct,
            ),
            // Informational only. The watch flags these; it does not close on them.
            gammaWarning: dte <= 3,
            wingBreachUrgent: dte <= 2,
            // The single field the scheduled job branches on, plus the sentence it should
            // journal if it acts. Both computed here so the job never does the arithmetic.
            fires: takeProfitFires ? "take-profit" : stopLossFires ? "stop-loss" : null,
            exitDebitToUse: Math.round(mid * 100) / 100,
            journalSentence: takeProfitFires
              ? `take-profit fired: live mid $${Math.round(mid * 100) / 100} against ${policy.describeTakeProfit}`
              : stopLossFires
                ? `stop-loss fired at ${Math.round(lossPct * 1000) / 10}% of max loss (${policy.describeStopLoss})`
                : null,
          };
        }),
      );

      res.json({
        asOf: new Date().toISOString(),
        asOfEasternTime: new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
        policy: {
          takeProfitMode: policy.takeProfitMode,
          takeProfitValue: policy.takeProfitValue,
          describeTakeProfit: policy.describeTakeProfit,
          stopLossPctOfMaxLoss: policy.stopLossPctOfMaxLoss,
          describeStopLoss: policy.describeStopLoss,
        },
        openCount: open.length,
        actionable: positions.filter((p: any) => p.fires).map((p: any) => p.id),
        unpriceable: positions.filter((p: any) => !p.priced).map((p: any) => p.id),
        positions,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Autonomous entry ----
  // Preview always runs regardless of the toggle and never writes: it is how the operator
  // inspects what the engine would do before trusting it to act.
  app.get("/api/auto-trade/preview", async (_req, res, next) => {
    try {
      res.json(
        await runAutoTrade({
          fetchChain: (symbol: string) => getChain(symbol),
          buildSnapshot: () => buildSignalSnapshot(getFlyLivePricing, getChain),
          }, { dryRun: true, ignoreToggle: true }),
      );
    } catch (err) {
      next(err);
    }
  });

  // The live run honours the toggle. No ignoreToggle escape hatch is exposed, so nothing
  // reachable over HTTP can open a position the operator has not switched on.
  app.post("/api/auto-trade/run", async (req, res, next) => {
    try {
      res.json(
        await runAutoTrade(
          {
            fetchChain: (symbol: string) => getChain(symbol),
            buildSnapshot: () => buildSignalSnapshot(getFlyLivePricing, getChain),
          },
          { dryRun: req.body?.dryRun === true },
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  // ---- Journal notes (freeform desk log, e.g. tuning-experiment entries) ----
  app.get("/api/journal-notes", async (_req, res, next) => {
    try {
      res.json(await storage.listJournalNotes());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/journal-notes", async (req, res, next) => {
    try {
      const parsed = insertJournalNoteSchema.parse(req.body);
      res.status(201).json(await storage.createJournalNote(parsed));
    } catch (err) {
      next(err);
    }
  });

  // ---- Trading copilot (advice-only chat widget) ----
  // Reports whether an API key is present so the widget can render a setup
  // message instead of a dead chat box.
  app.get("/api/copilot/status", (_req, res) => {
    // `key` carries shape-only facts (length, public prefix, stray-whitespace flags) to make
    // a 401 diagnosable. It never includes any part of the secret itself.
    res.json({ configured: isCopilotConfigured(), model: copilotModel, chatPolicy: copilotChatPolicy, key: describeApiKeyShape() });
  });

  // Diagnostic: which model ids the configured key can actually reach. Used to confirm
  // COPILOT_MODEL points at something real without redeploying to find out.
  app.get("/api/copilot/models", async (_req, res, next) => {
    try {
      res.json({ models: await listCopilotModels(), configured: copilotModel });
    } catch (err) {
      next(err);
    }
  });

  // The snapshot the copilot sees, exposed on its own so the context can be inspected
  // (and debugged) independently of a model call.
  app.get("/api/copilot/context", async (_req, res, next) => {
    try {
      res.json(await buildSignalSnapshot(getFlyLivePricing, getChain));
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/copilot/chat", async (req, res, next) => {
    try {
      if (!isCopilotConfigured()) {
        return res.status(503).json({
          message:
            "Copilot is not configured. Set COPILOT_API_KEY in the service environment to enable it.",
        });
      }
      const raw = Array.isArray(req.body?.messages) ? req.body.messages : null;
      if (!raw) return res.status(400).json({ message: "messages[] is required" });

      const messages: ChatMessage[] = raw
        .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
        .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));

      if (messages.length === 0) {
        return res.status(400).json({ message: "No valid messages provided" });
      }

      const requestId=z.string().uuid().parse(req.body.requestId??crypto.randomUUID());
      const existing=await draftForRequest(requestId);
      if(existing)return res.json({reply:"This request already saved a recommendation draft. Review it in Strategy → Recommendation drafts. No trade was executed.",model:copilotModel,draft:existing});
      const snapshot = await buildSignalSnapshot(getFlyLivePricing, getChain);
      const result = await runCopilotChat(messages, snapshot,(input,model)=>saveRecommendationDraft(input,requestId,model));
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  registerDraftRoutes(app);
  return httpServer;
}
