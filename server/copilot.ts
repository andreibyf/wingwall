// Wingwall trading copilot.
//
// Backs the floating chat widget. Two responsibilities:
//   1. buildSignalSnapshot() — assembles everything the desk currently knows (settings,
//      open flies priced live with threshold distances, closed-trade performance ledger,
//      campaign walls, execution checklist, recent journal log) into one compact JSON
//      object that is injected into every request. The model therefore answers from the
//      real book state, not from whatever the user remembers to type.
//   2. runCopilotChat() — calls the Anthropic Messages API with the desk system prompt.
//
// Advice-only by design: this module performs no writes. Entering, closing, and
// journalling stay with the operator and the threshold-watch job, so a chat reply can
// never move the book.
//
// Requires ANTHROPIC_API_KEY in the environment. Without it every endpoint reports
// configured:false and the widget renders a setup message instead of a chat box.

import type { Fly } from "@shared/schema";
import { getMultiplier } from "@shared/flyMath";
import { storage } from "./storage";
import { requestCopilotReply, getCopilotChatPolicy } from "./copilot-response";
import { analyzeChain, MONDAY_TO_THURSDAY_TRADING_DAYS, type ChainFn } from "./chain-analysis";
import {
  resolveExitPolicy,
  assessThresholdReachability,
  type ExitPolicy,
} from "../shared/exit-policy";

// Overridable so the service can be pointed at a gateway/proxy (or a stub during testing)
// without a code change. Defaults to Anthropic directly.
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

// Overridable so the model can be repointed from the Render dashboard without a redeploy.
const DEFAULT_MODEL = process.env.COPILOT_MODEL || "claude-haiku-4-5";
export const copilotChatPolicy = getCopilotChatPolicy(DEFAULT_MODEL, process.env.COPILOT_MAX_TOKENS);

// Thresholds used to live here as a pair of constants that silently duplicated
// shared/thresholds.ts without importing it, so changing one left the copilot quoting a
// policy the automation would not actually apply. They now come from the settings row via
// resolveExitPolicy, which is the only source the cockpit, the copilot and the scheduled
// job all read.

/**
 * Read the key defensively. Pasting into a dashboard field very often carries a trailing
 * newline or a stray space, and Anthropic rejects that with a 401 that looks identical to
 * a genuinely bad key — so trim rather than making the user hunt for invisible whitespace.
 */
function readApiKey(): string {
  // COPILOT_API_KEY is the preferred name because the base URL may point at any
  // Anthropic-Messages-compatible provider (e.g. Perplexity's router), where a variable
  // called ANTHROPIC_API_KEY is actively misleading. The old name still works.
  const raw = process.env.COPILOT_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
  return raw.trim();
}

export function isCopilotConfigured(): boolean {
  return readApiKey().length > 0;
}

/**
 * Shape-only facts about the configured key, for diagnosing a 401 without ever exposing the
 * secret. Reveals nothing beyond length, the public prefix, and whether stray whitespace or
 * quote characters were wrapped around it.
 */
export function describeApiKeyShape() {
  const fromPreferred = process.env.COPILOT_API_KEY;
  const raw = fromPreferred ?? process.env.ANTHROPIC_API_KEY ?? "";
  const trimmed = raw.trim();
  return {
    present: raw.length > 0,
    readFrom: fromPreferred ? "COPILOT_API_KEY" : "ANTHROPIC_API_KEY",
    length: trimmed.length,
    prefix: trimmed.slice(0, 7),
    looksLikeAnthropicKey: trimmed.startsWith("sk-ant-"),
    looksLikePerplexityKey: trimmed.startsWith("pplx-"),
    baseUrl: ANTHROPIC_BASE,
    hadSurroundingWhitespace: raw !== trimmed,
    hasInteriorWhitespace: /\s/.test(trimmed),
    isQuoteWrapped: /^["'].*["']$/.test(trimmed),
  };
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

type PricingFn = (
  symbol: string,
  optionType: "call" | "put",
  expiration: string,
  lowerStrike: number,
  middleStrike: number,
  upperStrike: number,
  contracts: number,
) => Promise<any>;

function todayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Precompute the week's key dates so the model never performs weekday arithmetic itself.
 * Language models reliably get this wrong — an early version of this copilot told the user to
 * key the "week of 2026-09-16" (a Wednesday) and pull the "2026-09-26" expiry (a Saturday).
 * Deriving these from the calendar and labelling every date with its weekday removes the
 * opportunity for that class of error entirely.
 */
function tradingCalendar(today: string) {
  const withDay = (iso: string) =>
    `${iso} (${new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })})`;

  const shift = (iso: string, days: number) =>
    new Date(new Date(`${iso}T12:00:00Z`).getTime() + days * 86_400_000)
      .toISOString()
      .slice(0, 10);

  // getUTCDay: 0=Sun … 6=Sat. Anchor on the Monday of the current calendar week; on a
  // weekend, roll forward to the coming Monday since no trade is keyed on a closed market.
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const isWeekend = dow === 0 || dow === 6;
  const mondayOffset = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow;
  const keyingMonday = shift(today, mondayOffset);
  const thursdayExpiration = shift(keyingMonday, 3);

  return {
    today: withDay(today),
    isWeekend,
    marketOpenToday: !isWeekend,
    keyingMonday: withDay(keyingMonday),
    thursdayExpiration: withDay(thursdayExpiration),
    tradingDaysMondayToThursday: 3,
    note: isWeekend
      ? "Market is closed today. keyingMonday and thursdayExpiration refer to the upcoming week."
      : "keyingMonday and thursdayExpiration refer to the current trading week.",
  };
}

function dteFrom(expiration: string, today: string): number {
  const a = new Date(`${expiration}T00:00:00Z`).getTime();
  const b = new Date(`${today}T00:00:00Z`).getTime();
  return Math.round((a - b) / 86_400_000);
}

function round(n: number | null | undefined, places = 2): number | null {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Realized P&L in dollars and R-multiples for a closed fly. */
function realizedFor(fly: Fly): { pnl: number; r: number } | null {
  if (fly.exitDebit === null || fly.exitDebit === undefined) return null;
  const pnl = (fly.exitDebit - fly.entryDebit) * getMultiplier(fly.symbol) * fly.contracts;
  // R denominator is max loss, never the debit — BWB max loss exceeds premium paid.
  return { pnl, r: fly.maxLoss ? pnl / fly.maxLoss : 0 };
}

/**
 * Whether the take-profit condition is met, under whichever mode is configured. A debit
 * multiple tests the live debit against what was paid; a percent-of-max-profit tests the
 * P&L fraction. Kept in one function so the two modes cannot drift apart between the
 * snapshot, the cockpit and the scheduled job.
 */
function takeProfitFiresFor(
  policy: ExitPolicy,
  entryDebit: number,
  midDebit: number,
  profitPct: number,
): boolean {
  if (policy.takeProfitMode === "multipleOfDebit") {
    return entryDebit > 0 && midDebit >= entryDebit * policy.takeProfitValue;
  }
  return profitPct >= policy.takeProfitValue;
}

/**
 * Everything the copilot is allowed to see, gathered fresh per request.
 * `priceFly` is injected by the caller so this module and the route layer share exactly
 * one pricing path (IBKR-first, Cboe fallback) and avoid a circular import.
 */
export async function buildSignalSnapshot(priceFly: PricingFn, fetchChain?: ChainFn) {
  const today = todayIso();
  const nowEt = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  const [settings, allFlies, walls, journalNotes] = await Promise.all([
    storage.getSettings(),
    storage.listFlies(),
    storage.listCampaignWalls(),
    storage.listJournalNotes(),
  ]);

  // One resolution of the exit policy per snapshot, shared by every position below and by
  // the automatedThresholds block, so nothing in a single response can disagree with
  // anything else about when an exit fires.
  const exitPolicy = resolveExitPolicy({
    takeProfitMode: settings?.takeProfitMode ?? "multipleOfDebit",
    takeProfitValue: settings?.takeProfitValue ?? 2.0,
    stopLossPctOfMaxLoss: settings?.stopLossPctOfMaxLoss ?? -0.4,
  });

  const openFlies = allFlies.filter((f) => f.status === "open");
  const closedFlies = allFlies.filter((f) => f.status === "closed");

  // --- Open positions, priced live, with distance to each automated threshold ---
  const open = await Promise.all(
    openFlies.map(async (fly) => {
      const dte = dteFrom(fly.expiration, today);
      const base = {
        id: fly.id,
        symbol: fly.symbol,
        optionType: fly.optionType,
        structureType: fly.structureType,
        strikes: `${fly.lowerStrike}/${fly.middleStrike}/${fly.upperStrike}`,
        body: fly.middleStrike,
        contracts: fly.contracts,
        expiration: fly.expiration,
        dte,
        entryDate: fly.entryDate,
        entryDebit: fly.entryDebit,
        maxLoss: round(fly.maxLoss),
        maxProfit: round(fly.maxProfit),
        peakProfitPctOfMaxProfit: round(fly.peakProfitPct, 4),
        peakLossPctOfMaxLoss: round(fly.peakLossPct, 4),
        gammaWarning: dte <= 3,
        wingBreachUrgent: dte <= 2,
        notes: fly.notes ?? null,
      };

      try {
        const p = await priceFly(
          fly.symbol,
          fly.optionType as "call" | "put",
          fly.expiration,
          fly.lowerStrike,
          fly.middleStrike,
          fly.upperStrike,
          fly.contracts,
        );
        if (p.midDebit === null || p.midDebit === undefined) {
          return { ...base, pricing: { available: false, reason: p.source } };
        }
        const pnl = (p.midDebit - fly.entryDebit) * getMultiplier(fly.symbol) * fly.contracts;
        const profitPct = fly.maxProfit ? pnl / fly.maxProfit : 0;
        const lossPct = fly.maxLoss ? pnl / fly.maxLoss : 0;
        return {
          ...base,
          pricing: {
            available: true,
            source: p.source,
            spot: round(p.spot),
            midDebit: round(p.midDebit),
            unrealizedPnl: round(pnl),
            rMultiple: round(fly.maxLoss ? pnl / fly.maxLoss : 0, 3),
            // The two fractions the automated watch actually tests, asymmetric on purpose:
            // the profit side divides by maxProfit, the loss side by maxLoss. Both are signed
            // off the same P&L, so a winning position has a POSITIVE lossPctOfMaxLoss — it is
            // not "partway to the stop". Only the *Fires flags and the gap fields below should
            // be used to talk about threshold proximity.
            profitPctOfMaxProfit: round(profitPct, 4),
            lossPctOfMaxLoss: round(lossPct, 4),
            takeProfitFires: takeProfitFiresFor(exitPolicy, fly.entryDebit, p.midDebit, profitPct),
            stopLossFires: lossPct <= exitPolicy.stopLossPctOfMaxLoss,
            // Signed gaps to each trigger, in the same units as the fraction they test.
            // Positive = not yet triggered, and the value is how far it still has to travel.
            takeProfitGapRemainingPct:
              exitPolicy.takeProfitMode === "pctOfMaxProfit"
                ? round(exitPolicy.takeProfitValue - profitPct, 4)
                : null,
            // Under a debit-multiple policy the meaningful gap is in debit terms, not as a
            // fraction of a max profit the target no longer references.
            takeProfitTargetDebit:
              exitPolicy.takeProfitMode === "multipleOfDebit"
                ? round(fly.entryDebit * exitPolicy.takeProfitValue)
                : null,
            stopLossGapRemainingPct: round(lossPct - exitPolicy.stopLossPctOfMaxLoss, 4),
            // Precomputed because the model cannot divide: what each threshold demands, as
            // a multiple of what was paid, with an explicit flag when the target is out of
            // reach. A 25%-of-max-profit target on a cheap far-body fly needed 4-5x the
            // debit on every trade in this book, so the stop could fire and the target
            // could not -- invisible unless it arrives pre-computed.
            thresholdReachability: assessThresholdReachability(
              exitPolicy,
              fly.entryDebit,
              fly.maxProfit,
              fly.maxLoss,
              fly.contracts,
              getMultiplier(fly.symbol),
              fly.peakProfitPct,
            ),
            bodyDistanceFromSpot:
              p.spot ? round(((fly.middleStrike - p.spot) / p.spot) * 100) : null,
            breakevenLower: round(p.breakevenLower),
            breakevenUpper: round(p.breakevenUpper),
            insideProfitTent:
              p.spot && p.breakevenLower && p.breakevenUpper
                ? p.spot > p.breakevenLower && p.spot < p.breakevenUpper
                : null,
          },
        };
      } catch (err) {
        return {
          ...base,
          pricing: { available: false, reason: err instanceof Error ? err.message : String(err) },
        };
      }
    }),
  );

  // --- Realized performance ledger (R-multiples, per defined-risk accounting) ---
  const realized = closedFlies
    .map((f) => ({ fly: f, r: realizedFor(f) }))
    .filter((x): x is { fly: Fly; r: { pnl: number; r: number } } => x.r !== null);

  const wins = realized.filter((x) => x.r.pnl > 0);
  const losses = realized.filter((x) => x.r.pnl < 0);
  const grossProfit = wins.reduce((s, x) => s + x.r.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x.r.pnl, 0));

  const performance = {
    closedTrades: realized.length,
    cumulativePnl: round(realized.reduce((s, x) => s + x.r.pnl, 0)),
    winRate: realized.length ? round(wins.length / realized.length, 3) : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 2) : null,
    expectancyR: realized.length
      ? round(realized.reduce((s, x) => s + x.r.r, 0) / realized.length, 3)
      : null,
    // Newest exit first. Sorted explicitly rather than trusting the storage layer's order.
    recentClosed: [...realized]
      .sort((a, b) => (b.fly.exitDate ?? "").localeCompare(a.fly.exitDate ?? "") || b.fly.id - a.fly.id)
      .slice(0, 8)
      .map((x) => ({
        id: x.fly.id,
        symbol: x.fly.symbol,
        optionType: x.fly.optionType,
        strikes: `${x.fly.lowerStrike}/${x.fly.middleStrike}/${x.fly.upperStrike}`,
        entryDate: x.fly.entryDate,
        exitDate: x.fly.exitDate,
        entryDebit: x.fly.entryDebit,
        exitDebit: x.fly.exitDebit,
        realizedPnl: round(x.r.pnl),
        rMultiple: round(x.r.r, 3),
        // Did it ever cross a threshold before it was actually closed?
        peakProfitPctOfMaxProfit: round(x.fly.peakProfitPct, 4),
        peakLossPctOfMaxLoss: round(x.fly.peakLossPct, 4),
      })),
  };

  // --- Campaign walls; newest week first, newest row wins within a week ---
  // The id tie-break matters: if a week was keyed more than once, the latest row is the
  // live one, and without it the "current wall" would be arbitrary.
  const sortedWalls = [...walls].sort(
    (a, b) => b.weekOf.localeCompare(a.weekOf) || b.id - a.id,
  );
  const currentWall = sortedWalls[0] ?? null;

  // One entry per prior week, so a re-keyed week doesn't crowd out real history.
  const priorWalls: typeof sortedWalls = [];
  const seenWeeks = new Set<string>(currentWall ? [currentWall.weekOf] : []);
  for (const w of sortedWalls) {
    if (seenWeeks.has(w.weekOf)) continue;
    seenWeeks.add(w.weekOf);
    priorWalls.push(w);
    if (priorWalls.length === 3) break;
  }

  const checklist = currentWall ? await storage.getChecklist(currentWall.weekOf) : null;

  // --- Chain analysis -------------------------------------------------------
  // Computed here rather than left to the model. The copilot cannot be trusted with
  // this arithmetic (it could not determine a weekday), and these numbers drive strike
  // selection, so a confident miscalculation would be expensive. A chain outage must
  // not take the whole copilot down with it, so failures degrade to available:false.
  const cal = tradingCalendar(today);
  const targetExpiration = cal.thursdayExpiration.slice(0, 10);
  let chainAnalysis: ReturnType<typeof analyzeChain> = {
    available: false,
    reason: "Chain analysis was not requested for this snapshot.",
  };
  if (fetchChain) {
    try {
      const chain = await fetchChain(settings.defaultSymbol);
      chainAnalysis = analyzeChain(chain, targetExpiration, MONDAY_TO_THURSDAY_TRADING_DAYS, today);
    } catch (err) {
      chainAnalysis = {
        available: false,
        reason: `Could not load the ${settings.defaultSymbol} option chain: ${
          err instanceof Error ? err.message : String(err)
        }. Say the chain is unavailable rather than reasoning from remembered levels.`,
      };
    }
  }

  // Spot only appears here when an open position was priced this request. With a flat
  // book there is no live quote in the snapshot, and the prompt requires the model to say
  // so rather than fabricate one.
  const anyPricedSpot =
    open.find((o: any) => o.pricing?.available && o.pricing.spot)?.pricing?.spot ?? null;

  return {
    asOfEasternTime: nowEt,
    today,
    // Authoritative dates. The prompt forbids the model from deriving weekdays itself.
    calendar: tradingCalendar(today),
    chainAnalysis,
    account: {
      balance: settings?.accountBalance ?? null,
      riskPerTradePercent: settings?.riskPerTradePercent ?? null,
      maxRiskPerTradeDollars:
        settings?.accountBalance && settings?.riskPerTradePercent
          ? round((settings.accountBalance * settings.riskPerTradePercent) / 100)
          : null,
      defaultSymbol: settings?.defaultSymbol ?? null,
    },
    automatedThresholds: {
      takeProfitMode: exitPolicy.takeProfitMode,
      takeProfitValue: exitPolicy.takeProfitValue,
      takeProfitDescription: exitPolicy.describeTakeProfit,
      stopLossAtPctOfMaxLoss: exitPolicy.stopLossPctOfMaxLoss,
      stopLossDescription: exitPolicy.describeStopLoss,
      configuredIn: "Settings, stored in the database — not hardcoded",
      note:
        "A scheduled job checks open flies hourly during market hours and auto-closes on " +
        "either threshold. Read takeProfitDescription rather than assuming a percent-of-max-" +
        "profit rule; the default is a multiple of the entry debit.",
    },
    openPositions: open,
    capitalDeployed: round(openFlies.reduce((s, f) => s + f.maxLoss, 0)),
    performance,
    // Deliberately named mostRecentCampaignWall, not "current". The newest stored wall is
    // frequently weeks old, and calling it "current" invited confidently reporting a stale
    // branch as if it governed today. Staleness is computed here so it cannot be overlooked.
    mostRecentCampaignWall: currentWall
      ? (() => {
          const cal = tradingCalendar(today);
          const keyingMondayIso = cal.keyingMonday.slice(0, 10);
          const weeksOld = Math.floor(
            (new Date(`${keyingMondayIso}T12:00:00Z`).getTime() -
              new Date(`${currentWall.weekOf}T12:00:00Z`).getTime()) /
              (7 * 86_400_000),
          );
          const isStale = currentWall.weekOf !== keyingMondayIso;
          return {
            symbol: currentWall.symbol,
            weekOf: currentWall.weekOf,
            wallPrice: currentWall.wallPrice,
            referenceClose: currentWall.referenceClose,
            activeBranch: currentWall.activeBranch,
            gapPercent: currentWall.gapPercent,
            reKeyed: currentWall.reKeyed,
            notes: currentWall.notes,
            isStale,
            weeksOld: Math.max(0, weeksOld),
            appliesToKeyingMonday: keyingMondayIso,
            staleWarning: isStale
              ? `This wall was keyed for the week of ${currentWall.weekOf} and does NOT govern the keying week of ${keyingMondayIso}. Its levels, branch, reference close and gap are historical. Say so before discussing it, and do not present its branch as the current one.`
              : null,
          };
        })()
      : null,
    priorCampaignWalls: priorWalls.map((w) => ({
      symbol: w.symbol,
      weekOf: w.weekOf,
      wallPrice: w.wallPrice,
      activeBranch: w.activeBranch,
    })),
    executionChecklist: checklist ?? null,
    // Newest note first. Sorted explicitly — taking a slice off the end of the storage
    // layer's order silently returned the OLDEST notes instead of the newest.
    recentJournal: [...journalNotes]
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      .slice(0, 12)
      .map((n) => ({ date: n.date, category: n.category, text: n.text })),
    liveSpotFromOpenPositions: anyPricedSpot,
  };
}

const SYSTEM_PROMPT = `You are the Wingwall trading copilot — an in-app assistant for a one-person defined-risk options desk trading debit butterflies on QQQ/SPY (and MES with manual pricing).

You are ADVICE-ONLY. You cannot place, modify, or close positions, and you cannot write journal entries. Never claim to have done any of those. When an action is warranted, tell the operator exactly what to do and where in the app to do it.

## Live context
Every message includes a DESK SNAPSHOT JSON block: account settings, open positions priced live with their distance to each automated threshold, the realized performance ledger, the most recent campaign wall with a staleness flag, the execution checklist, and the recent journal. Ground every specific number in that snapshot. If a value you need is absent or pricing is unavailable, say so plainly — never invent a spot price, a strike, a wall level, or a fill.

Chain analysis. The snapshot carries a chainAnalysis block computed server-side from the live option chain. Quote its numbers verbatim and never recalculate, re-rank, or estimate them; you are not reliable at this arithmetic and these values drive strike selection. When available is false, say the chain is unavailable and give the reason field — never substitute remembered or plausible-sounding levels.

Use the two lenses the way the playbook intends. gammaWall.topStrikes is the largest-gamma lens and is the correct basis for body placement. It can disagree sharply with a raw open-interest ranking, and when it does, trust it: a far out-of-the-money strike can carry enormous open interest while contributing almost no gamma, which makes it look like a wall in a table while exerting no pinning force. structuralPutWall and structuralCallWall are the durable levels aggregated across all expirations — useful context for where price may travel, but a heavy structural strike is not automatically a valid body.

bodyCandidates already scores each level against the playbook's two-expected-move limit. Recommend only strikes with qualifiesAsPinBody true, and when the operator asks about one that is false, quote its verdict and decline rather than softening it. If every candidate is disqualified, the honest answer is that no valid pin body exists this week and the correct action is to stand down, not to pick the least-bad strike. When liquidity.isThin is true, lead with liquidity.warning before naming any level from that expiration, and describe those levels as provisional.

Wall staleness. The snapshot field is mostRecentCampaignWall, not "current" — the newest stored wall is often weeks old. When isStale is true you must lead with the staleWarning before any discussion of that wall, describe its branch in the past tense as what WAS keyed for its week, and never answer "what is my current branch" with a stale branch as though it governs today. The correct answer in that case is that no wall has been keyed for the current week yet and one must be run before trading. A stale wall's referenceClose, gapPercent and notes are historical too; do not present them as this week's levels.

Dates and weekdays. NEVER derive, count, or guess a weekday, a week-start, or an expiration date yourself — you get this wrong. The snapshot's calendar block already carries today's date, whether the market is open today, the keying Monday, and that week's Thursday expiration, each labelled with its weekday. Quote those verbatim and use no other dates. If the user needs a date the calendar block does not contain, say you will not guess it rather than computing it. When calendar.isWeekend is true, today is not a trading day and the keying Monday and Thursday expiration refer to the upcoming week, not the one that just ended.

Reading the threshold fields correctly. The two threshold fractions are asymmetric by design: profitPctOfMaxProfit divides P&L by max profit, lossPctOfMaxLoss divides the SAME signed P&L by max loss. So a winning position shows a positive lossPctOfMaxLoss — that does NOT mean it is partway to the stop. Only takeProfitFires / stopLossFires and the two GapRemainingPct fields describe threshold proximity; never narrate lossPctOfMaxLoss as progress toward a stop on a position that is up. Never state a threshold from memory: the exit policy is configurable and lives in the snapshot. Read automatedThresholds.takeProfitDescription and stopLossDescription for the rule in force, and per-position thresholdReachability for what each exit demands. The default take-profit is a MULTIPLE OF THE ENTRY DEBIT, not a percent of max profit, so do not describe it as a percentage. When thresholdReachability.takeProfitIsUnreachable is true, say so plainly and quote unreachableReason -- it means the stop can fire while the target cannot, and the operator needs to hear that before the position decays rather than after. A position priced with available:false has no P&L this request — say the pricing is unavailable and give the reason field, rather than reasoning from the entry debit as if it were current.

## The operator's playbook — reason within it, do not improvise a new method

Structure. A long debit butterfly is +1/-2/+1 across three strikes. The debit paid is the max loss on a symmetric fly. Max profit is wing width minus debit, realized only on a perfect body pin at expiry — treat it as a theoretical ceiling, never as an expectation or a forecast. Keep the debit near half the wing width (a ~2:1 reward:risk floor). Body placement needs two lenses to agree: the largest-gamma strike (call wall / put wall / gamma flip) AND the 1-standard-deviation expected move. A body on an attractive wall two expected moves away is a hope, not a pin trade. Broken-wing flies are directional skew trades where max loss EXCEEDS the debit paid.

Risk accounting. Capital deployed = max loss = money at risk, because every position is a long debit structure. Performance is measured in R-multiples with max loss as the denominator — always max loss, never the debit, specifically so a cheap BWB entry cannot masquerade as better risk-adjusted. Report R, win rate, profit factor, and expectancy from the snapshot's ledger rather than estimating.

Campaign scenario keying. Each week is keyed on one governing question: how price behaves at the wall. Three branches — wall REJECTS (fades below): enter the original bear-ladder and satellite strikes as written. Wall GRINDS (holds): re-center, shifting fly bodies ~2% below the open and the satellite ~3% below. Wall BREAKS (sustained through): cut the bear ladder to fewer lots, pull the Thursday reserve fly forward as primary, skip the gap-patch ticket. A gap beyond ~2.5% at the Wednesday-night open overrides everything and re-keys at Thursday's open; if the open is violent enough that the levels no longer apply, stand down entirely and re-run levels off the new print.

Execution rules, non-negotiable. No fills in the first 15 minutes — the working window is 9:45-10:30 AM ET, acting off the opening range and not the bell. Start every limit at mid, improve $0.05 every 2-3 minutes, cancel at max-pay; a missed fill is cheaper than a chased one. Clip entries 2-3 lots per order rather than full size. Buy bear tents on strength and call structures on weakness, since fly bodies cheapen as spot moves away. Verify all three strikes against the blocked-strikes list before sending. Log every fill, because all scalp and exit triggers are percentages of actual fills, not model marks.

Cadence. Key Monday's opening print, target Thursday expiry. If that Monday is a market holiday, the keying day shifts to Tuesday, same Thursday expiry, accepting the shorter two-day hold. Thursday and Friday are never fresh-entry days: Thursday is the reserve structure contingent on Wednesday's expiry crush; Friday is exit-only with a 2 PM curfew.

Governance. Rule 4a: spot-distance cuts are suspended when a scheduled macro or earnings catalyst falls before expiry and the remaining debit is under 40% of basis — the optionality is already paid for, so cutting sells something already owned. Rule 4b: before overriding any rule, name its class. A behavioral rule may never be overridden. A market-state rule requires naming what concretely changed — a new print, a new gamma map, a new blockade. "The tape feels different" is not a change. The hedge is what licenses discretion: overriding a cut is justified only with a defined hedge underneath.

Directional input. The branch choice is cross-referenced against Mark Newton's (Fundstrat) published technical levels, treated as a lean to weigh against the live open, not a blind read. Dealer-gamma positioning is weighed alongside the live tape.

## How to answer
Be direct and decisive. This operator explicitly wants mentoring and a recommendation, not a menu of options — commit to a call and give the reasoning. Lead with the answer, then support it.

Separate cleanly what is (a) read from the snapshot, (b) computed by you, and (c) your judgment call. Label judgment calls as judgment calls. Never present an invented strike, lot size, or wall level as if it came from the playbook — the operator has asked for exactly this distinction.

Be honest about limits. You have no live news feed, no gamma-exposure map, and no Fundstrat notes inside this chat; if a question needs those, say which input is missing and what you would do with it. Be skeptical of precise-sounding numbers from free aggregator sources.

The account is small (roughly $1,000 of real practice capital) and the operator is newer to this, so weight capital preservation and mechanical discipline over cleverness, and flag when a proposed trade breaks a sizing or window rule.

Keep replies tight — a few short paragraphs or a compact list. This renders in a small floating chat panel, so no long preambles, and use markdown sparingly (bold and simple bullets only, no tables or headers).`;

/**
 * Single-turn model call with a caller-supplied system prompt. Exposed so the auto-trade
 * gatekeeper can reuse this module's key handling, base URL and model selection instead of
 * building a second, separately-configured client that could drift to a different model.
 */
export async function callModelOnce(
  system: string,
  userContent: string,
  maxTokens = 1200,
): Promise<{ text: string; model: string }> {
  const apiKey = readApiKey();
  if (!apiKey) throw Object.assign(new Error("Copilot is not configured"), { status: 503 });

  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    let detail = body.slice(0, 400);
    try {
      detail = JSON.parse(body)?.error?.message ?? detail;
    } catch {
      /* keep raw text */
    }
    throw Object.assign(new Error(`Anthropic API ${res.status}: ${detail}`), { status: 502 });
  }

  const data = await res.json();
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("")
        .trim()
    : "";
  return { text, model: data?.model ?? DEFAULT_MODEL };
}

export type CopilotResult = { reply: string; model: string };

export async function runCopilotChat(
  messages: ChatMessage[],
  snapshot: unknown,
): Promise<CopilotResult> {
  const apiKey = readApiKey();
  if (!apiKey) throw Object.assign(new Error("Copilot is not configured"), { status: 503 });

  const history = messages.filter((m) =>
    m.content.trim().length > 0 &&
    !(m.role === "assistant" && m.content.trim() === "(empty response)")
  ).slice(-16);
  if (history.length === 0) {
    throw Object.assign(new Error("At least one message is required"), { status: 400 });
  }

  // Snapshot rides on the final user turn so it is always the freshest state the model
  // sees, and so earlier turns in a long conversation don't carry stale numbers forward.
  const lastIdx = history.length - 1;
  const payloadMessages = history.map((m, i) =>
    i === lastIdx && m.role === "user"
      ? {
          role: m.role,
          content: `<desk_snapshot>\n${JSON.stringify(snapshot, null, 2)}\n</desk_snapshot>\n\n${m.content}`,
        }
      : { role: m.role, content: m.content },
  );

  return requestCopilotReply(async (maxTokens) => {
  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      ...copilotChatPolicy,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: payloadMessages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    let detail = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message ?? detail;
    } catch {
      /* keep raw text */
    }
    // Surfaced verbatim so a bad model id or an exhausted credit balance is diagnosable
    // from the widget instead of collapsing into a generic failure.
    throw Object.assign(new Error(`Anthropic API ${res.status}: ${detail}`), {
      status: res.status === 401 || res.status === 403 ? 502 : res.status,
    });
  }

  return res.json();
  }, copilotChatPolicy.max_tokens, DEFAULT_MODEL);
}

/** Lists model ids the configured key can actually reach — used to verify setup. */
export async function listCopilotModels(): Promise<string[]> {
  const apiKey = readApiKey();
  if (!apiKey) throw Object.assign(new Error("Copilot is not configured"), { status: 503 });
  const res = await fetch(`${ANTHROPIC_BASE}/models?limit=50`, {
    headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`), {
      status: 502,
    });
  }
  const data = await res.json();
  return Array.isArray(data?.data) ? data.data.map((m: any) => m.id) : [];
}

export const copilotModel = DEFAULT_MODEL;
