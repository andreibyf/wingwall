// Gexbot v2 API client -- dealer-positioning levels as a second opinion on the keyed wall.
//
// WHY THIS EXISTS
// Wingwall's wall used to come from a proxy: gamma-weighted open interest per strike off
// the free delayed CBOE chain, peak strike wins. That proxy picked 729 for the week of
// 2026-09-21. A full-chain GEX recomputation later put the dominant overhead gamma at 725
// (+676M) with 729 a minor strike in the trough (+157M), and the wall was re-keyed. The
// proxy was not merely imprecise, it was wrong, because it read a single expiration and
// ranked raw OI rather than gamma-weighted exposure across the chain. Gexbot publishes the
// major positive and negative GEX levels and the zero-gamma line directly, so the keyed
// wall can cite a provider number instead of an in-house approximation.
//
// THE CONSTRAINT THAT SHAPES EVERYTHING BELOW
// Gexbot is metered per quota POOL, not as one global budget, and each pool carries its
// own daily AND monthly ceiling. `/majors` draws on `api_majors`, which is documented as a
// SMALLER allowance than `api_default` and which grows Classic -> State -> Orderflow. We
// are on Classic, the smallest. Two consequences, both deliberate:
//
//   1. NOTHING here may be called from a scheduled job. The exit watch alone fires eight
//      times a session; the entry and confirmation runs add two more. Every entry point is
//      operator-initiated and every result is cached in Postgres.
//   2. One refresh spends exactly ONE request. Gexbot publishes no account/entitlement
//      endpoint, so unlike the FlashAlpha design this replaced there is no tier lookup to
//      pay for. The tier is configuration, not a discovered fact -- which means it can be
//      wrong, so a 403 is reported as a possible tier mismatch rather than a hard fault.
//
// WHY `gex_full` AND NOT `gex_zero`/`gex_one`
// Wingwall keys a wall on Monday and holds a butterfly to Thursday. 0DTE and 1DTE
// aggregations describe a horizon shorter than the trade. `gex_full` is the 90-day
// aggregate and is the only category whose horizon contains the position. This is a
// judgment call about which published series best fits the strategy, not a provider
// recommendation.
//
// FRESHNESS
// Gexbot recomputes GEX-by-open-interest once daily at 08:30 ET pre-market, when new OCC
// clearance figures land. That is the natural cadence for Monday wall keying: a refresh
// after 08:30 ET reflects Friday's settled open interest. Polling more often than daily
// buys nothing on the OI series and spends a scarce `api_majors` request.

const GEXBOT_BASE = process.env.GEXBOT_BASE_URL?.replace(/\/+$/, "") || "https://api.gex.bot/v2";

// Accept the plausible spellings rather than force a round trip with the operator over a
// variable name. `GEXBOT_API_KEY` is the documented choice; the rest are fallbacks.
const KEY_ENV_CANDIDATES = [
  "GEXBOT_API_KEY",
  "GEX_BOT_API_KEY",
  "GEXBOT_KEY",
  "GEXBOT_TOKEN",
];

// Gexbot's OpenAPI repository is explicit that the bearer token must carry this prefix.
// A key pasted from the dashboard without it fails auth in a way that looks identical to a
// revoked key, so normalise here and report the normalisation in the status payload.
const KEY_PREFIX = "gexbot_custom_";

// Descriptive User-Agent is a REQUIRED header on every route, including the public ones.
const USER_AGENT = "wingwall/1.0 (+https://wingwall.onrender.com)";

// Observed from the unauthenticated `GET /v2/tickers` probe on 2026-09-20. Held as a local
// constant rather than fetched: coverage changes rarely, and a live check would spend a
// request to learn something that has been stable. Wingwall's own SUPPORTED_SYMBOLS is
// {QQQ, SPY} and both are covered, so this guard exists to catch a future symbol addition
// before it costs quota, not to second-guess Gexbot.
const COVERED_TICKERS = new Set([
  "AAPL", "DIA", "GLD", "HYG", "IWM", "QQQ", "SPY", "TLT", "TQQQ", "TSLA",
  "NDX", "RUT", "SPX", "VIX", "ES_SPX", "NQ_NDX",
]);

// `/majors` and `/{ticker}/classic/{category}` accept these. The web app's URL hashes use
// different names (90d, latest, next); those are not API categories and must not leak here.
export const CLASSIC_CATEGORIES = ["gex_full", "gex_zero", "gex_one", "full", "zero", "one"] as const;
export type ClassicCategory = (typeof CLASSIC_CATEGORIES)[number];

export const DEFAULT_CATEGORY: ClassicCategory = "gex_full";

export type GexbotTier = "classic" | "state" | "orderflow" | "unknown";

export interface GexbotLevels {
  symbol: string;
  category: ClassicCategory;
  /**
   * Major POSITIVE gamma LEVEL by open interest -- the overhead wall analogue.
   *
   * Not necessarily an exchange strike, despite the obvious reading of the field name. QQQ
   * lists $1 increments, and the live value on 2026-09-20 was 720.02, so the provider is
   * publishing an interpolated or weighted level rather than the single strike carrying the
   * most gamma. Do not round it to a strike on that assumption.
   */
  callWall: number | null;
  /**
   * Major NEGATIVE gamma LEVEL by open interest -- the downside acceleration band. Came back
   * as exactly 700.00 on 2026-09-20, which happens to be a strike, but the positive side was
   * not -- so an integer here is a coincidence to distrust, not a guarantee.
   */
  putWall: number | null;
  /** Zero-gamma line: the regime pivot. */
  gammaFlip: number | null;
  gammaFlipStatus: string | null;
  /** Derived from the sign of net_gex_oi, not published as a string by Gexbot. */
  regime: string | null;
  /** Gexbot documents this as null when spot is not available to the caller. */
  spot: number | null;
  netGexOi: number | null;
  /** Provider's own unix timestamp for the snapshot, seconds. */
  providerTimestamp: number | null;
  raw: unknown;
}

/**
 * Why `reason` is a closed union rather than a message string: the UI renders a genuinely
 * different affordance for each case. `tier_or_permission` is an upgrade prompt,
 * `rate_limited` is "wait for the reset", `no_key` is a deployment problem, `not_covered`
 * is a configuration mistake, and `http_error` is a fault. Collapsing them into prose
 * would force the UI to parse English to decide what to show.
 */
export type GexbotFailure =
  | { ok: false; reason: "no_key"; detail: string }
  | { ok: false; reason: "not_covered"; detail: string }
  | { ok: false; reason: "rate_limited"; detail: string }
  | { ok: false; reason: "unauthorized"; detail: string }
  | { ok: false; reason: "tier_or_permission"; detail: string }
  | { ok: false; reason: "bad_request"; detail: string }
  | { ok: false; reason: "not_found"; detail: string }
  | { ok: false; reason: "http_error"; detail: string; status: number }
  | { ok: false; reason: "network_error"; detail: string };

export type GexbotResult<T> = { ok: true; value: T } | GexbotFailure;

export function resolveKey(): { key: string | null; envName: string | null; prefixAdded: boolean } {
  for (const name of KEY_ENV_CANDIDATES) {
    const v = process.env[name];
    if (typeof v === "string" && v.trim().length > 0) {
      const trimmed = v.trim();
      if (trimmed.startsWith(KEY_PREFIX)) {
        return { key: trimmed, envName: name, prefixAdded: false };
      }
      return { key: KEY_PREFIX + trimmed, envName: name, prefixAdded: true };
    }
  }
  return { key: null, envName: null, prefixAdded: false };
}

export function resolveTier(): GexbotTier {
  const s = String(process.env.GEXBOT_TIER ?? "classic").toLowerCase().trim();
  if (s === "classic" || s === "state" || s === "orderflow") return s;
  return "unknown";
}

export function isCovered(symbol: string): boolean {
  return COVERED_TICKERS.has(symbol.toUpperCase());
}

export function isValidCategory(c: string): c is ClassicCategory {
  return (CLASSIC_CATEGORIES as readonly string[]).indexOf(c) !== -1;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pulls Gexbot's `{ "error": "..." }` body out without assuming it is present. */
async function errorDetail(res: Response, fallback: string): Promise<string> {
  try {
    const body: any = await res.json();
    const msg = body?.error ?? body?.detail ?? body?.title;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  } catch {
    // Documented: the body CAN be empty on 401 and 403. Not an anomaly.
  }
  return fallback;
}

async function request(path: string, timeoutMs: number): Promise<GexbotResult<unknown>> {
  const { key } = resolveKey();
  if (!key) {
    return {
      ok: false,
      reason: "no_key",
      detail: "No Gexbot key in the environment. Checked: " + KEY_ENV_CANDIDATES.join(", "),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${GEXBOT_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (err: any) {
    return {
      ok: false,
      reason: "network_error",
      detail:
        err?.name === "AbortError"
          ? `Timed out after ${timeoutMs}ms`
          : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    return {
      ok: false,
      reason: "unauthorized",
      detail: await errorDetail(
        res,
        "Gexbot rejected the key (HTTP 401): missing, unknown, expired or revoked. " +
          `Check that the stored value carries the ${KEY_PREFIX} prefix -- a key without ` +
          "it fails exactly like a revoked one.",
      ),
    };
  }
  if (res.status === 403) {
    // Gexbot's spec separates 401 (key not recognised) from 403 (key, subscription level
    // or client not permitted). On Classic the overwhelmingly likely cause is a route or
    // category above the tier, so name that first without asserting it.
    return {
      ok: false,
      reason: "tier_or_permission",
      detail: await errorDetail(
        res,
        `Gexbot returned 403: the key, the subscription level or the client is not ` +
          `permitted for this route. Configured tier is "${resolveTier()}"; /majors on ` +
          `Classic should be permitted, so this points at a tier lower than configured ` +
          `or a route outside the plan.`,
      ),
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      reason: "rate_limited",
      detail: await errorDetail(
        res,
        "Gexbot quota exceeded. /majors draws on the api_majors pool, which is smaller " +
          "than api_default and has both a daily and a monthly ceiling. Daily quotas " +
          "reset at midnight ET; a monthly breach will not clear until the cycle rolls.",
      ),
    };
  }
  if (res.status === 400) {
    return {
      ok: false,
      reason: "bad_request",
      detail: await errorDetail(res, "Gexbot returned 400 -- ticker or category rejected."),
    };
  }
  if (res.status === 404) {
    // Path order on this API is TICKER FIRST (/{ticker}/classic/{category}/majors). Every
    // guess that put `classic` first returned 404 during integration, so say so: it is the
    // single most likely cause of a 404 here and it is a code bug, not a data gap.
    //
    // Gexbot's own 404 body is the bare string "Not Found", which is too terse to act on.
    // So unlike every other branch here, the provider message AUGMENTS the explanation
    // instead of replacing it -- letting "Not Found" win would throw away the one piece of
    // information that actually resolves this failure.
    const provider = await errorDetail(res, "");
    const guidance =
      "Gexbot returned 404. Either the ticker is not carried, or the path is malformed " +
      "-- the route is /{ticker}/classic/{category}/majors, ticker first.";
    return {
      ok: false,
      reason: "not_found",
      detail: provider ? `${guidance} Provider said: ${provider}` : guidance,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: "http_error",
      status: res.status,
      detail: await errorDetail(res, `HTTP ${res.status} from Gexbot.`),
    };
  }

  try {
    return { ok: true, value: await res.json() };
  } catch (err: any) {
    return {
      ok: false,
      reason: "http_error",
      status: res.status,
      detail: `Malformed JSON from Gexbot: ${String(err?.message ?? err)}`,
    };
  }
}

/**
 * Key levels for one symbol from the slim `/majors` route.
 *
 * Mapping note, stated plainly because it is interpretation rather than fact: Wingwall's
 * "wall" is an OVERHEAD level, so it maps to `mpos_oi`, the major positive-GEX level by
 * open interest. The open-interest series is preferred over the volume series (`mpos_vol`)
 * because OI reflects settled positioning that persists across sessions, which is what a
 * Monday-to-Thursday structure trades against; volume is intraday churn. Gexbot does not
 * label either series a "wall".
 */
export async function getLevels(
  symbol: string,
  category: ClassicCategory = DEFAULT_CATEGORY,
  timeoutMs = 10000,
): Promise<GexbotResult<GexbotLevels>> {
  const sym = symbol.toUpperCase();

  if (!isCovered(sym)) {
    return {
      ok: false,
      reason: "not_covered",
      detail:
        `${sym} is not in Gexbot's carried ticker set as observed on 2026-09-20. No ` +
        `request was sent, so no api_majors quota was spent on a call that would 404.`,
    };
  }

  const r = await request(
    `/${encodeURIComponent(sym)}/classic/${encodeURIComponent(category)}/majors`,
    timeoutMs,
  );
  if (!r.ok) return r;

  const body: any = r.value ?? {};
  // The spec types `majors_response` as a bare object. Accept a wrapper anyway rather than
  // assume, since the producer has been observed to omit fields elsewhere in this API.
  const node = body.majors ?? body.data ?? body;

  const netGexOi = toNumberOrNull(node.net_gex_oi);
  const gammaFlip = toNumberOrNull(node.zero_gamma);

  return {
    ok: true,
    value: {
      symbol: sym,
      category,
      callWall: toNumberOrNull(node.mpos_oi),
      putWall: toNumberOrNull(node.mneg_oi),
      gammaFlip,
      // Gexbot publishes no status string for the flip. Derive one rather than invent a
      // provider field: absent is materially different from present-and-zero.
      gammaFlipStatus: gammaFlip === null ? "unavailable" : "resolved",
      regime: netGexOi === null ? null : netGexOi >= 0 ? "positive" : "negative",
      spot: toNumberOrNull(node.spot),
      netGexOi,
      providerTimestamp: toNumberOrNull(node.timestamp),
      raw: body,
    },
  };
}
