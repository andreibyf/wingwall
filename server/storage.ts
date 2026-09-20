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
import { eq, desc } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required (Render Postgres connection string)");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

export const db = drizzle(pool);

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
