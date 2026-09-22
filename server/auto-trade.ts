// Autonomous entry: propose in code, let the model veto, record both.
//
// The division of labour is deliberate and not negotiable by configuration. buildProposal()
// picks the body, the wings and the lot size from the chain and the risk settings. The
// model receives that finished structure and answers one question -- take it or leave it --
// then writes the reasoning in the operator's own terms. It cannot move a strike, change a
// lot size, or substitute an expiration. The worst a compromised or confused model can do
// here is decline a good trade or approve a structure the code already validated.
//
// Everything fails closed. An unparseable verdict, a missing field, a model outage, a
// thrown error: no position. The only path that opens a fly is an explicit approval that
// parsed cleanly, and even then only when the operator has switched the toggle on.

import { storage } from "./storage";
import { buildProposal, branchPolicy, type FlyProposal, type BranchPolicy } from "./proposal-engine";
import { analyzeChain, MONDAY_TO_THURSDAY_TRADING_DAYS, type ChainFn, type ChainData } from "./chain-analysis";
import { resolveExitPolicy, type ExitPolicy } from "../shared/exit-policy";
import { callModelOnce } from "./copilot";
import { entryWindow, eastern, freshQuote, remainingSessions } from "./automation-policy";
import {paperMode} from "./automation-control";
import { commitPaperEntry } from "./paper-ledger";
import { assertButterflyReview } from "./strategy-store";

export interface GatekeeperVerdict {
  approved: boolean;
  confidence: "high" | "medium" | "low";
  rationale: string;
  concerns: string[];
  /** Set when the verdict could not be trusted; forces a decline. */
  parseError: string | null;
  model: string | null;
}

export type AutoTradeOutcome =
  | "entered"
  | "would_enter"
  | "declined_by_model"
  | "no_proposal"
  | "disabled"
  | "already_open"
  | "error";

export interface AutoTradeRun {
  ranAt: string;
  outcome: AutoTradeOutcome;
  detail: string;
  dryRun: boolean;
  autoTradeEnabled: boolean;
  branch: string | null;
  branchPolicy: BranchPolicy | null;
  proposal: FlyProposal | null;
  verdict: GatekeeperVerdict | null;
  flyId: number | null;
  journalNoteId: number | null;
}

const GATEKEEPER_SYSTEM = `You are the risk gate on an options desk that trades defined-risk butterflies.

A proposal has already been constructed in code from the live option chain and the desk's
risk settings. The body, the wing widths and the lot size are FIXED. You cannot change them,
suggest different strikes, or propose a different expiration. Any such suggestion will be
discarded.

Your only job is to answer one question: should this structure be entered as written, right
now? Then explain why in two or three sentences, in plain desk language, as a note the
operator will read in their journal weeks later.

Approve when the structure is consistent with the keyed branch and nothing in the snapshot
contradicts it. Decline when something in the snapshot genuinely argues against entering --
for example the chain is flagged thin and the body rests on that thin expiration, the wall
is stale so the branch no longer describes the market, the position would stack risk on top
of an existing one, or a take-profit target is flagged unreachable so the trade can only
ever be stopped out.

Do not decline merely because a trade is speculative or the reward:risk looks unusual. A
cheap butterfly far from the body is the intended instrument here, not an error. Do not
invent numbers: every figure you cite must appear in the payload.

Respond with ONLY a JSON object, no prose outside it, no code fence:
{"approved": true|false, "confidence": "high"|"medium"|"low", "rationale": "...", "concerns": ["..."]}`;

/**
 * Parse the verdict strictly. A model that returns anything other than a clean, complete
 * object gets treated as a decline rather than having its intent guessed at -- approving a
 * position on a half-understood response is the one failure mode worth being paranoid
 * about.
 */
export function parseVerdict(text: string, model: string): GatekeeperVerdict {
  const decline = (parseError: string): GatekeeperVerdict => ({
    approved: false,
    confidence: "low",
    rationale: "Automated entry declined: the risk gate's response could not be trusted.",
    concerns: [parseError],
    parseError,
    model,
  });

  if (!text || !text.trim()) return decline("empty response from the model");

  // Tolerate a fenced block, since that is a formatting slip rather than a judgment
  // failure, but nothing looser than that.
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return decline(`response was not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed?.approved !== "boolean") {
    return decline("the 'approved' field was missing or not a boolean");
  }
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  if (!rationale) return decline("the 'rationale' field was missing or empty");
  if(!["high","medium","low"].includes(parsed.confidence) || !Array.isArray(parsed.concerns) ||
    !parsed.concerns.every((value:unknown)=>typeof value==="string")) return decline("confidence or concerns did not match the verdict schema");

  const confidence =
    parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? parsed.confidence
      : "low";

  return {
    approved: parsed.approved,
    confidence,
    rationale,
    concerns: Array.isArray(parsed.concerns)
      ? parsed.concerns.filter((c: unknown) => typeof c === "string" && c.trim()).slice(0, 8)
      : [],
    parseError: null,
    model,
  };
}

export interface AutoTradeDeps {
  fetchChain: ChainFn;
  buildSnapshot: () => Promise<unknown>;
  /** Injected for tests; defaults to the shared model client. */
  askModel?: typeof callModelOnce;
  now?: Date;
}

export interface AutoTradeOptions {
  /** Build and judge a proposal without opening anything. */
  dryRun?: boolean;
  /** Ignore the stored toggle. Used by the preview endpoint, never by the scheduled run. */
  ignoreToggle?: boolean;
}

export async function runAutoTrade(
  deps: AutoTradeDeps,
  opts: AutoTradeOptions = {},
): Promise<AutoTradeRun> {
  const now = deps.now ?? new Date();
  const ranAt = now.toISOString();
  const today = eastern(now).date;
  const dryRun = opts.dryRun === true;

  const base: AutoTradeRun = {
    ranAt,
    outcome: "error",
    detail: "",
    dryRun,
    autoTradeEnabled: false,
    branch: null,
    branchPolicy: null,
    proposal: null,
    verdict: null,
    flyId: null,
    journalNoteId: null,
  };

  const [settings, allFlies, walls] = await Promise.all([
    storage.getSettings(),
    storage.listFlies(),
    storage.listCampaignWalls(),
  ]);

  const enabled = settings?.autoTradeEnabled === true;
  base.autoTradeEnabled = enabled;
  if(!dryRun && process.env.PAPER_ENTRY_ENABLED==="false")
    return {...base,outcome:"disabled",detail:"Entries locked off by deployment configuration."};

  if (!enabled && !opts.ignoreToggle) {
    return { ...base, outcome: "disabled", detail: "Autonomous entry is switched off in Settings." };
  }
  const window = entryWindow(now);
  if (!window.allowed) return { ...base, outcome:"no_proposal", detail:window.reason };
  if (!dryRun && await paperMode() !== "paper") return { ...base, outcome:"disabled", detail:"Paper workers are in observation mode." };

  // One position at a time. Stacking a second fly on an open one doubles deployed capital
  // without any of the sizing arithmetic knowing it happened.
  const openFlies = allFlies.filter((f) => f.status === "open");
  if (openFlies.length > 0) {
    return {
      ...base,
      outcome: "already_open",
      detail:
        `${openFlies.length} position${openFlies.length === 1 ? "" : "s"} already open ` +
        `(ids ${openFlies.map((f) => f.id).join(", ")}). Autonomous entry does not stack.`,
    };
  }

  const symbol = settings?.defaultSymbol ?? "QQQ";
  try {await assertButterflyReview(symbol,now);}
  catch(err) {return {...base,outcome:"no_proposal",detail:(err as Error).message};}
  const exitPolicy: ExitPolicy = resolveExitPolicy({
    takeProfitMode: settings?.takeProfitMode ?? "multipleOfDebit",
    takeProfitValue: settings?.takeProfitValue ?? 2.0,
    stopLossPctOfMaxLoss: settings?.stopLossPctOfMaxLoss ?? -0.4,
  });

  // The branch comes from the most recent stored wall. A wall keyed for an earlier week
  // does not describe this week's market, so the branch is only honoured when its week
  // matches; otherwise there is no active branch and the engine stands down.
  const newestWall = walls
    .filter(w => w.symbol === symbol)
    .slice()
    .sort((a, b) => (a.weekOf < b.weekOf ? 1 : a.weekOf > b.weekOf ? -1 : b.id - a.id))[0];
  const keyingMonday = window.monday;
  const wallApplies = newestWall?.weekOf === keyingMonday;
  const branch = wallApplies ? newestWall?.activeBranch ?? null : null;
  const bp = branchPolicy(branch ?? "");
  base.branch = branch;
  base.branchPolicy = bp;

  if (!wallApplies) {
    return {
      ...base,
      outcome: "no_proposal",
      detail: newestWall
        ? `The most recent wall is keyed for ${newestWall.weekOf}, not the current keying week ` +
          `${keyingMonday}. A stale wall does not define a branch, so there is nothing to enter.`
        : "No campaign wall has ever been keyed, so there is no branch to trade.",
    };
  }

  let chain: ChainData | null = null;
  try {
    chain = await deps.fetchChain(symbol);
  } catch (err) {
    return {
      ...base,
      outcome: "error",
      detail: `Could not load the ${symbol} option chain: ${(err as Error).message}`,
    };
  }
  if (!freshQuote(chain?.timestamp, now)) return { ...base, outcome:"no_proposal", detail:"Chain quote is missing a timezone-qualified timestamp or is more than two minutes old." };

  const cal = tradingWeek(today);
  const analysis = analyzeChain(chain, cal.thursdayExpiration, remainingSessions(today,cal.thursdayExpiration), today);
  const proposal = buildProposal(
    chain,
    analysis,
    bp,
    {
      accountBalance: settings?.accountBalance ?? 0,
      riskPerTradePercent: settings?.riskPerTradePercent ?? 0,
      targetDebitToWidth: settings?.targetDebitToWidth ?? 0.06,
      maxDebitToWidth: settings?.maxDebitToWidth ?? 0.15,
    },
    exitPolicy,
    newestWall?.referenceClose ?? null,
    // Only read when the branch is breaks, but passed unconditionally so the engine -- not
    // this caller -- decides when the wall is a binding constraint.
    newestWall?.wallPrice ?? null,
  );
  base.proposal = proposal;

  if (!proposal.viable) {
    return { ...base, outcome: "no_proposal", detail: proposal.reason ?? "No viable structure." };
  }

  // --- Gatekeeper -----------------------------------------------------------
  let verdict: GatekeeperVerdict;
  try {
    const snapshot = await deps.buildSnapshot();
    const ask = deps.askModel ?? callModelOnce;
    const payload =
      `<desk_snapshot>\n${JSON.stringify(snapshot, null, 2)}\n</desk_snapshot>\n\n` +
      `<proposal>\n${JSON.stringify(proposal, null, 2)}\n</proposal>\n\n` +
      `The keyed branch is "${branch}". ${bp.note}\n\n` +
      `Approve or decline this structure as written.`;
    const { text, model } = await ask(GATEKEEPER_SYSTEM, payload, 8192);
    verdict = parseVerdict(text, model);
  } catch (err) {
    // A model outage must not become an unreviewed entry.
    verdict = {
      approved: false,
      confidence: "low",
      rationale: "Automated entry declined: the risk gate could not be reached.",
      concerns: [(err as Error).message],
      parseError: (err as Error).message,
      model: null,
    };
  }
  base.verdict = verdict;

  if (!verdict.approved) {
    const detail = `Risk gate declined: ${verdict.rationale}`;
    if (!dryRun) {
      // A decline is recorded too. A journal that only contains the trades that happened
      // cannot answer "why was there no trade that week", which is the question the
      // learning loop most needs later.
      const note = await storage.createJournalNote({
        date: today,
        category: "general",
        text:
          `Autonomous entry declined by the risk gate (${verdict.model ?? "model unavailable"}, ` +
          `confidence ${verdict.confidence}). Branch "${branch}". ` +
          `Proposed structure was ${proposal.optionType} ` +
          `${proposal.lowerStrike}/${proposal.middleStrike}/${proposal.upperStrike} exp ` +
          `${proposal.expiration}, ${proposal.contracts}x at $${proposal.entryDebit} ` +
          `($${proposal.maxLoss} risk). Reason: ${verdict.rationale}` +
          (verdict.concerns.length ? ` Concerns: ${verdict.concerns.join("; ")}` : "") +
          (verdict.parseError ? ` [gate failure: ${verdict.parseError}]` : ""),
      });
      base.journalNoteId = note.id;
    }
    return { ...base, outcome: "declined_by_model", detail };
  }

  if (dryRun) {
    return {
      ...base,
      outcome: "would_enter",
      detail: "Dry run: the structure was approved but nothing was opened.",
    };
  }

  // --- Enter, and journal the reasoning in the same run ---------------------
  const result = await commitPaperEntry({ settingsSnapshot:settings, wallSnapshot:newestWall,
    ...(deps.now?{now:()=>deps.now!}:{}),
    quoteTimestamp:chain!.timestamp,
    journal:`Branch ${branch}. Model ${verdict.model}: ${verdict.rationale}. ${proposal.bodyRationale}. ${proposal.wingRationale}. ${proposal.sizingRationale}. Quote ${chain!.timestamp}. Simulated mid, no broker order or fill.`,
    fly:{
    symbol: proposal.symbol,
    optionType: proposal.optionType!,
    structureType: "symmetric",
    expiration: proposal.expiration!,
    lowerStrike: proposal.lowerStrike!,
    middleStrike: proposal.middleStrike!,
    upperStrike: proposal.upperStrike!,
    contracts: proposal.contracts!,
    entryDebit: proposal.entryDebit!,
    entryDate: today,
    status: "open",
    exitDebit: null,
    exitDate: null,
    maxLoss: proposal.maxLoss!,
    maxProfit: proposal.maxProfit!,
    campaignWallId: newestWall?.id ?? null,
    notes:
      `Opened by autonomous entry on branch "${branch}". Risk gate ` +
      `(${verdict.model}) approved with ${verdict.confidence} confidence.`,
    peakProfitPct: null,
    peakLossPct: null,
  }});
  base.flyId = result.flyId;
  base.journalNoteId = result.journalNoteId;

  return {
    ...base,
    outcome: "entered",
    detail:
      `Opened paper Fly ${result.flyId}: ${proposal.optionType} ` +
      `${proposal.lowerStrike}/${proposal.middleStrike}/${proposal.upperStrike}, ` +
      `${proposal.contracts}x at $${proposal.entryDebit}, $${proposal.maxLoss} at risk.`,
  };
}

/**
 * The Monday of the campaign week an ISO date belongs to.
 *
 * Campaign weeks run Monday through the Thursday expiration, so once Thursday has passed
 * the week is spent and a date belongs to the NEXT week's keying, not the one just closed.
 * Friday, Saturday and Sunday therefore roll forward. A naive "Monday of the calendar week"
 * would have had a Saturday run hunting for a wall keyed to a Thursday expiration that had
 * already expired. All arithmetic is in UTC so a local-timezone offset cannot shift the day.
 */
export function keyingMondayFor(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun, 1 Mon ... 5 Fri, 6 Sat
  const delta = dow === 0 ? 1 : dow === 6 ? 2 : dow === 5 ? 3 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Monday and Thursday of the campaign week an ISO date belongs to. */
export function tradingWeek(iso: string): { keyingMonday: string; thursdayExpiration: string } {
  const keyingMonday = keyingMondayFor(iso);
  const d = new Date(`${keyingMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3);
  return { keyingMonday, thursdayExpiration: d.toISOString().slice(0, 10) };
}
