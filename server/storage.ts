import { users, flies, campaignWalls, settings, executionChecklist, journalNotes } from '@shared/schema';
import type {
  User,
  InsertUser,
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
} from '@shared/schema';
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and, inArray, desc } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required (Render Postgres connection string)");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

export const db = drizzle(pool);

// Outcome of collapsing a duplicated (symbol, weekOf) group. A refusal is returned as data
// rather than thrown: "the row you chose is no longer in that group" is an ordinary race
// with another tab, and the UI needs to say which rows survived, not show a 500.
export type ResolveDuplicateWallsResult =
  | { ok: true; kept: CampaignWall; deletedIds: number[]; fliesRepointed: number }
  | { ok: false; reason: "keep_not_in_group"; detail: string };

// Bootstrap tables if they don't exist yet (no migration runner in this environment).
export async function ensureSchema(): Promise<void> {
  await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flies (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  option_type TEXT NOT NULL,
  structure_type TEXT NOT NULL DEFAULT 'symmetric',
  expiration TEXT NOT NULL,
  lower_strike REAL NOT NULL,
  middle_strike REAL NOT NULL,
  upper_strike REAL NOT NULL,
  contracts INTEGER NOT NULL DEFAULT 1,
  entry_debit REAL NOT NULL,
  entry_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  exit_debit REAL,
  exit_date TEXT,
  max_loss REAL NOT NULL,
  max_profit REAL NOT NULL,
  campaign_wall_id INTEGER,
  notes TEXT,
  peak_profit_pct REAL,
  peak_loss_pct REAL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_walls (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  week_of TEXT NOT NULL,
  wall_price REAL NOT NULL,
  reference_close REAL,
  active_branch TEXT NOT NULL DEFAULT 'pending',
  gap_percent REAL,
  re_keyed BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  account_balance REAL NOT NULL DEFAULT 1000,
  risk_per_trade_percent REAL NOT NULL DEFAULT 10,
  default_symbol TEXT NOT NULL DEFAULT 'QQQ',
  take_profit_mode TEXT NOT NULL DEFAULT 'multipleOfDebit',
  take_profit_value REAL NOT NULL DEFAULT 2.0,
  stop_loss_pct_of_max_loss REAL NOT NULL DEFAULT -0.4,
  target_debit_to_width REAL NOT NULL DEFAULT 0.06,
  max_debit_to_width REAL NOT NULL DEFAULT 0.15,
  auto_trade_enabled BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS execution_checklist (
  id INTEGER PRIMARY KEY,
  week_of TEXT NOT NULL,
  no_early_fills BOOLEAN NOT NULL DEFAULT false,
  working_window_respected BOOLEAN NOT NULL DEFAULT false,
  clipped_sizing BOOLEAN NOT NULL DEFAULT false,
  blocked_strikes_verified BOOLEAN NOT NULL DEFAULT false,
  fills_logged BOOLEAN NOT NULL DEFAULT false,
  thursday_reserve_deployed BOOLEAN NOT NULL DEFAULT false,
  friday_curfew_respected BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS journal_notes (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

  // Additive migration: older databases predate the peak-tracking columns.
  await pool.query(`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'flies' AND column_name = 'peak_profit_pct'
  ) THEN
    ALTER TABLE flies ADD COLUMN peak_profit_pct REAL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'flies' AND column_name = 'peak_loss_pct'
  ) THEN
    ALTER TABLE flies ADD COLUMN peak_loss_pct REAL;
  END IF;
END $$;
`);

  // Additive migration: exit policy and structure targeting moved out of code and into
  // settings, so databases created before that change lack these columns. Every column is
  // NOT NULL with a default matching the previous hardcoded behaviour except
  // take_profit_mode, which deliberately defaults to the new debit-multiple policy -- the
  // old percent-of-max-profit target was unreachable on this book's structures and could
  // only ever fire the stop. Nothing is dropped, renamed or retyped, so this is safe to
  // re-run and safe to roll back to the previous release, which simply ignores the columns.
  await pool.query(`
ALTER TABLE settings ADD COLUMN IF NOT EXISTS take_profit_mode TEXT NOT NULL DEFAULT 'multipleOfDebit';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS take_profit_value REAL NOT NULL DEFAULT 2.0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS stop_loss_pct_of_max_loss REAL NOT NULL DEFAULT -0.4;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS target_debit_to_width REAL NOT NULL DEFAULT 0.06;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS max_debit_to_width REAL NOT NULL DEFAULT 0.15;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_trade_enabled BOOLEAN NOT NULL DEFAULT false;
`);

  // Gexbot dealer-positioning cache and quota ledger.
  //
  // The cache is not a latency optimisation -- it is a quota guard. /majors draws on the
  // api_majors pool, which Gexbot documents as SMALLER than api_default and which carries
  // both a daily and a monthly ceiling. A page that refetched on mount would spend that
  // budget on renders. Levels are fetched only on explicit operator action and read from
  // here every other time.
  //
  // WHY THE LEDGER KEYS ON EASTERN TIME, NOT UTC
  // Gexbot's quotas reset at midnight ET. An earlier draft of this table keyed on a UTC
  // date because the provider it was originally written against reset at midnight UTC.
  // Carrying that over would have put the local counter four or five hours out of step
  // with the provider's every single evening: between 20:00 ET and midnight ET the UTC date
  // has already rolled, so the ledger would report a fresh budget while Gexbot still
  // counted the old day. That is precisely the window an operator checks levels in before
  // the next session, so the disagreement would surface at the worst time.
  await pool.query(`
CREATE TABLE IF NOT EXISTS gex_levels_cache (
  symbol TEXT PRIMARY KEY,
  category TEXT,
  fetched_at TEXT NOT NULL,
  call_wall DOUBLE PRECISION,
  put_wall DOUBLE PRECISION,
  gamma_flip DOUBLE PRECISION,
  gamma_flip_status TEXT,
  regime TEXT,
  spot DOUBLE PRECISION,
  -- DOUBLE PRECISION rather than REAL, but for a narrower reason than an earlier revision of
  -- this comment claimed. That version said REAL was silently rounding net GEX from
  -- 1160076199 to 1160076160; that figure came from a TEST FIXTURE built on QuantData's raw
  -- notional scale, not from Gexbot. Live Gexbot returns a scaled value -- QQQ measured
  -- 7771.88 on 2026-09-20 -- which REAL would have carried without loss. So the corruption
  -- was never observed in production data and the claim was overstated.
  --
  -- The wider type is kept anyway: the provider does not document the scale or guarantee it,
  -- a scaled quantity carries decimals that float4 does erode, and widening a float column
  -- costs nothing here. Treat this as cheap insurance against an undocumented scale, not as
  -- the fix for a bug that was ever hit.
  net_gex_oi DOUBLE PRECISION,
  provider_timestamp BIGINT,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gex_usage (
  et_date TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);
`);

  // Applied additively so a database created by an earlier revision of this file picks the
  // columns up without a destructive migration, matching how the settings columns above are
  // handled. Render's Postgres is not reachable from a development sandbox, so every
  // migration has to be safe to run unattended at boot.
  await pool.query(`
ALTER TABLE gex_levels_cache ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE gex_levels_cache ADD COLUMN IF NOT EXISTS spot DOUBLE PRECISION;
ALTER TABLE gex_levels_cache ADD COLUMN IF NOT EXISTS net_gex_oi DOUBLE PRECISION;
ALTER TABLE gex_levels_cache ADD COLUMN IF NOT EXISTS provider_timestamp BIGINT;
-- Widen in place for any database that already took these columns as REAL. ALTER TYPE to a
-- wider float is a no-op when the type already matches, so this is safe to re-run at every
-- boot; it cannot recover precision already lost, but the cache is refetchable by design.
ALTER TABLE gex_levels_cache ALTER COLUMN call_wall TYPE DOUBLE PRECISION;
ALTER TABLE gex_levels_cache ALTER COLUMN put_wall TYPE DOUBLE PRECISION;
ALTER TABLE gex_levels_cache ALTER COLUMN gamma_flip TYPE DOUBLE PRECISION;
ALTER TABLE gex_levels_cache ALTER COLUMN spot TYPE DOUBLE PRECISION;
ALTER TABLE gex_levels_cache ALTER COLUMN net_gex_oi TYPE DOUBLE PRECISION;
`);
}

/**
 * Eastern-time day key -- matches Gexbot's midnight-ET quota reset, not the server's UTC
 * day and not the operator's device clock. Uses the IANA zone so the switch in and out of
 * daylight saving is handled by the runtime rather than by an offset constant that would
 * silently rot in November.
 */
export function etDateKey(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function getGexCallsToday(now: Date = new Date()): Promise<number> {
  const r = await pool.query(
    `SELECT calls FROM gex_usage WHERE et_date = $1`,
    [etDateKey(now)],
  );
  return r.rows.length ? Number(r.rows[0].calls) : 0;
}

export async function recordGexCall(now: Date = new Date()): Promise<number> {
  const r = await pool.query(
    `INSERT INTO gex_usage (et_date, calls) VALUES ($1, 1)
     ON CONFLICT (et_date) DO UPDATE SET calls = gex_usage.calls + 1
     RETURNING calls`,
    [etDateKey(now)],
  );
  return Number(r.rows[0].calls);
}

export interface CachedLevels {
  symbol: string;
  category: string | null;
  fetchedAt: string;
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
  gammaFlipStatus: string | null;
  regime: string | null;
  spot: number | null;
  netGexOi: number | null;
  providerTimestamp: number | null;
}

export async function getCachedLevels(symbol: string): Promise<CachedLevels | null> {
  const r = await pool.query(
    `SELECT symbol, category, fetched_at, call_wall, put_wall, gamma_flip,
            gamma_flip_status, regime, spot, net_gex_oi, provider_timestamp
       FROM gex_levels_cache WHERE symbol = $1`,
    [symbol.toUpperCase()],
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    symbol: row.symbol,
    category: row.category ?? null,
    fetchedAt: row.fetched_at,
    callWall: num(row.call_wall),
    putWall: num(row.put_wall),
    gammaFlip: num(row.gamma_flip),
    gammaFlipStatus: row.gamma_flip_status ?? null,
    regime: row.regime ?? null,
    spot: num(row.spot),
    netGexOi: num(row.net_gex_oi),
    providerTimestamp: num(row.provider_timestamp),
  };
}

export async function putCachedLevels(
  levels: {
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
    raw: unknown;
  },
  fetchedAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO gex_levels_cache
       (symbol, category, fetched_at, call_wall, put_wall, gamma_flip, gamma_flip_status,
        regime, spot, net_gex_oi, provider_timestamp, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (symbol) DO UPDATE SET
       category = EXCLUDED.category,
       fetched_at = EXCLUDED.fetched_at,
       call_wall = EXCLUDED.call_wall,
       put_wall = EXCLUDED.put_wall,
       gamma_flip = EXCLUDED.gamma_flip,
       gamma_flip_status = EXCLUDED.gamma_flip_status,
       regime = EXCLUDED.regime,
       spot = EXCLUDED.spot,
       net_gex_oi = EXCLUDED.net_gex_oi,
       provider_timestamp = EXCLUDED.provider_timestamp,
       payload = EXCLUDED.payload`,
    [
      levels.symbol.toUpperCase(),
      levels.category ?? null,
      fetchedAt,
      levels.callWall,
      levels.putWall,
      levels.gammaFlip,
      levels.gammaFlipStatus,
      levels.regime,
      levels.spot ?? null,
      levels.netGexOi ?? null,
      levels.providerTimestamp ?? null,
      JSON.stringify(levels.raw ?? null),
    ],
  );
}

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  listFlies(): Promise<Fly[]>;
  getFly(id: number): Promise<Fly | undefined>;
  createFly(fly: InsertFly): Promise<Fly>;
  updateFly(id: number, fly: Partial<InsertFly>): Promise<Fly | undefined>;
  deleteFly(id: number): Promise<void>;

  listCampaignWalls(): Promise<CampaignWall[]>;
  getCampaignWall(id: number): Promise<CampaignWall | undefined>;
  createCampaignWall(wall: InsertCampaignWall): Promise<CampaignWall>;
  updateCampaignWall(id: number, wall: Partial<InsertCampaignWall>): Promise<CampaignWall | undefined>;
  deleteCampaignWall(id: number): Promise<void>;
  resolveDuplicateCampaignWalls(
    symbol: string,
    weekOf: string,
    keepId: number,
  ): Promise<ResolveDuplicateWallsResult>;

  getSettings(): Promise<Settings>;
  updateSettings(s: Partial<InsertSettings>): Promise<Settings>;

  getChecklist(weekOf: string): Promise<ExecutionChecklist | undefined>;
  upsertChecklist(weekOf: string, patch: Partial<InsertExecutionChecklist>): Promise<ExecutionChecklist>;

  // Ratchets the fly's peak profit / trough loss (as % of maxProfit / maxLoss) up/down only,
  // never resets. No-op for closed flies — tracking is only meaningful while open.
  trackFlyExtreme(id: number, profitPct: number, lossPct: number): Promise<Fly | undefined>;

  listJournalNotes(): Promise<JournalNote[]>;
  createJournalNote(note: InsertJournalNote): Promise<JournalNote>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.id, id));
    return rows[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.username, username));
    return rows[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const rows = await db.insert(users).values(insertUser).returning();
    return rows[0];
  }

  async listFlies(): Promise<Fly[]> {
    return db.select().from(flies).orderBy(desc(flies.createdAt));
  }

  async getFly(id: number): Promise<Fly | undefined> {
    const rows = await db.select().from(flies).where(eq(flies.id, id));
    return rows[0];
  }

  async createFly(fly: InsertFly): Promise<Fly> {
    const rows = await db
      .insert(flies)
      .values({ ...fly, createdAt: new Date().toISOString() })
      .returning();
    return rows[0];
  }

  async updateFly(id: number, fly: Partial<InsertFly>): Promise<Fly | undefined> {
    const rows = await db.update(flies).set(fly).where(eq(flies.id, id)).returning();
    return rows[0];
  }

  async deleteFly(id: number): Promise<void> {
    await db.delete(flies).where(eq(flies.id, id));
  }

  async trackFlyExtreme(id: number, profitPct: number, lossPct: number): Promise<Fly | undefined> {
    const fly = await this.getFly(id);
    if (!fly || fly.status !== "open") return fly;
    const nextPeakProfit = Math.max(fly.peakProfitPct ?? -Infinity, profitPct);
    const nextPeakLoss = Math.min(fly.peakLossPct ?? Infinity, lossPct);
    if (nextPeakProfit === fly.peakProfitPct && nextPeakLoss === fly.peakLossPct) return fly; // no new extreme
    const rows = await db
      .update(flies)
      .set({ peakProfitPct: nextPeakProfit, peakLossPct: nextPeakLoss })
      .where(eq(flies.id, id))
      .returning();
    return rows[0];
  }

  async listCampaignWalls(): Promise<CampaignWall[]> {
    return db.select().from(campaignWalls).orderBy(desc(campaignWalls.createdAt));
  }

  async getCampaignWall(id: number): Promise<CampaignWall | undefined> {
    const rows = await db.select().from(campaignWalls).where(eq(campaignWalls.id, id));
    return rows[0];
  }

  async createCampaignWall(wall: InsertCampaignWall): Promise<CampaignWall> {
    const rows = await db
      .insert(campaignWalls)
      .values({ ...wall, createdAt: new Date().toISOString() })
      .returning();
    return rows[0];
  }

  async updateCampaignWall(id: number, wall: Partial<InsertCampaignWall>): Promise<CampaignWall | undefined> {
    const rows = await db.update(campaignWalls).set(wall).where(eq(campaignWalls.id, id)).returning();
    return rows[0];
  }

  async deleteCampaignWall(id: number): Promise<void> {
    await db.delete(campaignWalls).where(eq(campaignWalls.id, id));
  }

  // Collapse a duplicated (symbol, weekOf) down to one row.
  //
  // Two things make this a transaction rather than a loop of deletes from the client:
  //
  // 1. flies.campaign_wall_id references the rows being deleted. A logged fill pointing at
  //    a discarded wall would lose its campaign attribution silently -- the Journal would
  //    still show the trade, just no longer tied to the week it was traded under. So the
  //    surviving row adopts those flies in the same transaction.
  // 2. A partial failure here is worse than the duplication it is fixing: flies repointed
  //    but rows not deleted, or some rows deleted and others left, produces a state nobody
  //    designed for. All-or-nothing keeps the pre-existing duplicate state intact on
  //    failure, which is recoverable by simply trying again.
  //
  // The keeper is re-read inside the transaction rather than trusted from the request, so a
  // row deleted by another tab between the page render and the click cannot cause the
  // deletion of every sibling with nothing kept.
  async resolveDuplicateCampaignWalls(
    symbol: string,
    weekOf: string,
    keepId: number,
  ): Promise<ResolveDuplicateWallsResult> {
    return db.transaction(async (tx) => {
      const group = await tx
        .select()
        .from(campaignWalls)
        .where(and(eq(campaignWalls.symbol, symbol), eq(campaignWalls.weekOf, weekOf)));

      const kept = group.find((w) => w.id === keepId);
      if (!kept) {
        return {
          ok: false as const,
          reason: "keep_not_in_group" as const,
          detail:
            `Wall ${keepId} is not a ${symbol} wall for the week of ${weekOf}. Nothing was ` +
            `deleted. Reload the page and pick again — the rows may have changed since it loaded.`,
        };
      }

      const discardIds = group.filter((w) => w.id !== keepId).map((w) => w.id);
      if (discardIds.length === 0) {
        // Not an error: two tabs resolving the same group is the likely cause, and the end
        // state is the one that was asked for.
        return { ok: true as const, kept, deletedIds: [], fliesRepointed: 0 };
      }

      const repointed = await tx
        .update(flies)
        .set({ campaignWallId: kept.id })
        .where(inArray(flies.campaignWallId, discardIds))
        .returning({ id: flies.id });

      await tx.delete(campaignWalls).where(inArray(campaignWalls.id, discardIds));

      return {
        ok: true as const,
        kept,
        deletedIds: discardIds,
        fliesRepointed: repointed.length,
      };
    });
  }

  async getSettings(): Promise<Settings> {
    const rows = await db.select().from(settings).where(eq(settings.id, 1));
    if (rows[0]) return rows[0];
    const inserted = await db
      .insert(settings)
      .values({ id: 1, accountBalance: 1000, riskPerTradePercent: 10, defaultSymbol: "QQQ" })
      .returning();
    return inserted[0];
  }

  async updateSettings(s: Partial<InsertSettings>): Promise<Settings> {
    await this.getSettings();
    const rows = await db.update(settings).set(s).where(eq(settings.id, 1)).returning();
    return rows[0];
  }

  async getChecklist(weekOf: string): Promise<ExecutionChecklist | undefined> {
    const rows = await db.select().from(executionChecklist).where(eq(executionChecklist.id, 1));
    const row = rows[0];
    if (row && row.weekOf === weekOf) return row;
    return undefined;
  }

  async upsertChecklist(weekOf: string, patch: Partial<InsertExecutionChecklist>): Promise<ExecutionChecklist> {
    const rows = await db.select().from(executionChecklist).where(eq(executionChecklist.id, 1));
    const row = rows[0];
    if (!row || row.weekOf !== weekOf) {
      await db.delete(executionChecklist).where(eq(executionChecklist.id, 1));
      const inserted = await db
        .insert(executionChecklist)
        .values({
          id: 1,
          weekOf,
          noEarlyFills: false,
          workingWindowRespected: false,
          clippedSizing: false,
          blockedStrikesVerified: false,
          fillsLogged: false,
          thursdayReserveDeployed: false,
          fridayCurfewRespected: false,
          ...patch,
        })
        .returning();
      return inserted[0];
    }
    const updated = await db.update(executionChecklist).set(patch).where(eq(executionChecklist.id, 1)).returning();
    return updated[0];
  }

  async listJournalNotes(): Promise<JournalNote[]> {
    return db.select().from(journalNotes).orderBy(desc(journalNotes.createdAt));
  }

  async createJournalNote(note: InsertJournalNote): Promise<JournalNote> {
    const rows = await db
      .insert(journalNotes)
      .values({ ...note, createdAt: new Date().toISOString() })
      .returning();
    return rows[0];
  }
}

export const storage = new DatabaseStorage();
