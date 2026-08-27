// Live options pricing via the connected Interactive Brokers account, for exactly the
// 3 legs of a fly (not a full chain — IBKR's API is quote-per-contract, not a bulk
// chain download like Cboe's free delayed feed, so we only ever fetch the handful of
// contracts a specific fly actually needs).
//
// Confirmed empirically against this account (see project notes):
// - QQQ and SPY (equity options, SMART-routed): real-time bid/ask works.
// - MES (CME futures options, FOP): the chain STRUCTURE resolves fine (strikes,
//   contract ids), but get_price_snapshot returns an empty object for both the MES
//   future itself and its FOP contracts — this account has no CME real-time market
//   data subscription. So MES is intentionally NOT wired to IBKR here; it stays on
//   the manual-entry path in the UI.
import { execFile } from "node:child_process";

const IBKR_SOURCE = "interactive_brokers_ibkr_v2";

const UNDERLYINGS: Record<string, { contractId: number; exchange: string }> = {
  QQQ: { contractId: 320227571, exchange: "NASDAQ" },
  SPY: { contractId: 756733, exchange: "ARCA" },
};

export function isIbkrSupported(symbol: string): boolean {
  return symbol.toUpperCase() in UNDERLYINGS;
}

function callIbkrOnce(toolName: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ source_id: IBKR_SOURCE, tool_name: toolName, arguments: args });
    execFile("external-tool", ["call", payload], { timeout: 20_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ibkr ${toolName} failed: ${stderr || err.message}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        // The CLI returns HTTP 200 with a JSON body even on upstream connector
        // errors (e.g. transient IB Gateway hiccups), so check for `error` explicitly.
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          reject(new Error(`ibkr ${toolName} error: ${parsed.error}`));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error(`ibkr ${toolName} returned non-JSON output`));
      }
    });
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The connector occasionally returns a generic transient error ("Error invoking
// method: An error occurred. Please try again later.") for option-chain lookups —
// confirmed to self-resolve on retry. Retry a couple of times with short backoff
// before giving up and letting the caller fall back to the delayed feed.
async function callIbkr(toolName: string, args: Record<string, unknown>, retries = 2): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callIbkrOnce(toolName, args);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

type ExpirationRow = { id: string; date: string; regular: boolean };

type CacheEntry<T> = { data: T; ts: number };
const expirationsCache = new Map<string, CacheEntry<ExpirationRow[]>>();
const EXPIRATIONS_CACHE_MS = 30 * 60_000;

async function getExpirations(symbol: string): Promise<ExpirationRow[]> {
  const cached = expirationsCache.get(symbol);
  if (cached && Date.now() - cached.ts < EXPIRATIONS_CACHE_MS) return cached.data;

  const underlying = UNDERLYINGS[symbol];
  const raw = await callIbkr("get_option_parameters", {
    underlying_contract_id: underlying.contractId,
    option_sec_type: "OPT",
  });
  const rows: ExpirationRow[] = Array.isArray(raw?.expirations) ? raw.expirations : [];

  // A single calendar date can carry multiple ids (different trading_class variants,
  // e.g. quarterlies). Keep one row per date, preferring the standard `regular: true` one.
  const byDate = new Map<string, ExpirationRow>();
  for (const row of rows) {
    const existing = byDate.get(row.date);
    if (!existing || (row.regular && !existing.regular)) byDate.set(row.date, row);
  }
  const deduped = Array.from(byDate.values());
  expirationsCache.set(symbol, { data: deduped, ts: Date.now() });
  return deduped;
}

type OptionDataRow = { strike: string; call_contract_id: number; put_contract_id: number };
const optionDataCache = new Map<string, CacheEntry<OptionDataRow[]>>();
const OPTION_DATA_CACHE_MS = 5 * 60_000;

async function getOptionData(expirationId: string, minStrike: number, maxStrike: number): Promise<OptionDataRow[]> {
  const key = `${expirationId}:${minStrike}:${maxStrike}`;
  const cached = optionDataCache.get(key);
  if (cached && Date.now() - cached.ts < OPTION_DATA_CACHE_MS) return cached.data;

  const raw = await callIbkr("get_option_data", {
    expiration_id: expirationId,
    min_strike: minStrike,
    max_strike: maxStrike,
  });
  const rows: OptionDataRow[] = Array.isArray(raw?.contracts) ? raw.contracts : [];
  optionDataCache.set(key, { data: rows, ts: Date.now() });
  return rows;
}

type Quote = { bid: number; ask: number; mid: number } | null;

async function getQuote(contractId: number): Promise<Quote> {
  const raw = await callIbkr("get_price_snapshot", {
    contract_id: contractId,
    market_data_names: ["bid_ask", "last"],
  });
  const ba = raw?.["bid-ask"];
  const last = raw?.last?.price;
  if (ba && typeof ba.bid === "number" && typeof ba.ask === "number" && ba.bid > 0 && ba.ask > 0) {
    return { bid: ba.bid, ask: ba.ask, mid: (ba.bid + ba.ask) / 2 };
  }
  if (typeof last === "number" && last > 0) {
    return { bid: last, ask: last, mid: last };
  }
  return null;
}

export class IbkrPricingError extends Error {}

export type IbkrLeg = { strike: number; type: "call" | "put"; bid: number; ask: number; mid: number };
export type IbkrFlyQuote = { lowerLeg: IbkrLeg; middleLeg: IbkrLeg; upperLeg: IbkrLeg; spot: number | null };

// Fetches live bid/ask for exactly the 3 strikes of a fly. Throws IbkrPricingError on
// any failure (unsupported symbol, expiration not found, strikes not found, or no
// live quote available) — callers should catch this and fall back to the delayed feed.
export async function getIbkrFlyQuote(
  symbol: string,
  expirationDate: string, // YYYY-MM-DD
  optionType: "call" | "put",
  lowerStrike: number,
  middleStrike: number,
  upperStrike: number
): Promise<IbkrFlyQuote> {
  const underlying = UNDERLYINGS[symbol];
  if (!underlying) throw new IbkrPricingError(`${symbol} is not IBKR-supported`);

  const expirations = await getExpirations(symbol);
  const targetDate = expirationDate.replace(/-/g, "");
  const match = expirations.find((e) => e.date === targetDate);
  if (!match) throw new IbkrPricingError(`No IBKR expiration found for ${symbol} ${expirationDate}`);

  const minStrike = Math.min(lowerStrike, middleStrike, upperStrike);
  const maxStrike = Math.max(lowerStrike, middleStrike, upperStrike);
  const rows = await getOptionData(match.id, minStrike, maxStrike);

  const findRow = (strike: number) => rows.find((r) => Number(r.strike) === strike);
  const lowerRow = findRow(lowerStrike);
  const middleRow = findRow(middleStrike);
  const upperRow = findRow(upperStrike);
  if (!lowerRow || !middleRow || !upperRow) {
    throw new IbkrPricingError(`Strikes not found in IBKR chain for ${symbol} ${expirationDate}`);
  }

  const pickId = (row: OptionDataRow) => (optionType === "call" ? row.call_contract_id : row.put_contract_id);
  const [lowerQ, middleQ, upperQ, spotQ] = await Promise.all([
    getQuote(pickId(lowerRow)),
    getQuote(pickId(middleRow)),
    getQuote(pickId(upperRow)),
    getQuote(underlying.contractId).catch(() => null),
  ]);

  if (!lowerQ || !middleQ || !upperQ) {
    throw new IbkrPricingError(`No live quote available for ${symbol} ${expirationDate} strikes`);
  }

  const toLeg = (strike: number, q: NonNullable<Quote>): IbkrLeg => ({
    strike,
    type: optionType,
    bid: q.bid,
    ask: q.ask,
    mid: q.mid,
  });

  return {
    lowerLeg: toLeg(lowerStrike, lowerQ),
    middleLeg: toLeg(middleStrike, middleQ),
    upperLeg: toLeg(upperStrike, upperQ),
    spot: spotQ?.mid ?? null,
  };
}
