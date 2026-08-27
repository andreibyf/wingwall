import { users, flies, campaignWalls, settings, executionChecklist } from '@shared/schema';
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
} from '@shared/schema';
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

// Bootstrap tables if they don't exist yet (no migration runner in this sandbox).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_walls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  week_of TEXT NOT NULL,
  wall_price REAL NOT NULL,
  reference_close REAL,
  active_branch TEXT NOT NULL DEFAULT 'pending',
  gap_percent REAL,
  re_keyed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  account_balance REAL NOT NULL DEFAULT 1000,
  risk_per_trade_percent REAL NOT NULL DEFAULT 10,
  default_symbol TEXT NOT NULL DEFAULT 'QQQ'
);
CREATE TABLE IF NOT EXISTS execution_checklist (
  id INTEGER PRIMARY KEY,
  week_of TEXT NOT NULL,
  no_early_fills INTEGER NOT NULL DEFAULT 0,
  working_window_respected INTEGER NOT NULL DEFAULT 0,
  clipped_sizing INTEGER NOT NULL DEFAULT 0,
  blocked_strikes_verified INTEGER NOT NULL DEFAULT 0,
  fills_logged INTEGER NOT NULL DEFAULT 0,
  thursday_reserve_deployed INTEGER NOT NULL DEFAULT 0,
  friday_curfew_respected INTEGER NOT NULL DEFAULT 0
);
`);

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
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    return db.select().from(users).where(eq(users.id, id)).get();
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return db.select().from(users).where(eq(users.username, username)).get();
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    return db.insert(users).values(insertUser).returning().get();
  }

  async listFlies(): Promise<Fly[]> {
    return db.select().from(flies).orderBy(desc(flies.createdAt)).all();
  }

  async getFly(id: number): Promise<Fly | undefined> {
    return db.select().from(flies).where(eq(flies.id, id)).get();
  }

  async createFly(fly: InsertFly): Promise<Fly> {
    return db
      .insert(flies)
      .values({ ...fly, createdAt: new Date().toISOString() })
      .returning()
      .get();
  }

  async updateFly(id: number, fly: Partial<InsertFly>): Promise<Fly | undefined> {
    return db.update(flies).set(fly).where(eq(flies.id, id)).returning().get();
  }

  async deleteFly(id: number): Promise<void> {
    db.delete(flies).where(eq(flies.id, id)).run();
  }

  async listCampaignWalls(): Promise<CampaignWall[]> {
    return db.select().from(campaignWalls).orderBy(desc(campaignWalls.createdAt)).all();
  }

  async getCampaignWall(id: number): Promise<CampaignWall | undefined> {
    return db.select().from(campaignWalls).where(eq(campaignWalls.id, id)).get();
  }

  async createCampaignWall(wall: InsertCampaignWall): Promise<CampaignWall> {
    return db
      .insert(campaignWalls)
      .values({ ...wall, createdAt: new Date().toISOString() })
      .returning()
      .get();
  }

  async updateCampaignWall(id: number, wall: Partial<InsertCampaignWall>): Promise<CampaignWall | undefined> {
    return db.update(campaignWalls).set(wall).where(eq(campaignWalls.id, id)).returning().get();
  }

  async deleteCampaignWall(id: number): Promise<void> {
    db.delete(campaignWalls).where(eq(campaignWalls.id, id)).run();
  }

  async getSettings(): Promise<Settings> {
    const existing = db.select().from(settings).where(eq(settings.id, 1)).get();
    if (existing) return existing;
    return db
      .insert(settings)
      .values({ id: 1, accountBalance: 1000, riskPerTradePercent: 10, defaultSymbol: "QQQ" })
      .returning()
      .get();
  }

  async updateSettings(s: Partial<InsertSettings>): Promise<Settings> {
    await this.getSettings();
    return db.update(settings).set(s).where(eq(settings.id, 1)).returning().get();
  }

  async getChecklist(weekOf: string): Promise<ExecutionChecklist | undefined> {
    const row = db.select().from(executionChecklist).where(eq(executionChecklist.id, 1)).get();
    if (row && row.weekOf === weekOf) return row;
    return undefined;
  }

  async upsertChecklist(weekOf: string, patch: Partial<InsertExecutionChecklist>): Promise<ExecutionChecklist> {
    const row = db.select().from(executionChecklist).where(eq(executionChecklist.id, 1)).get();
    if (!row || row.weekOf !== weekOf) {
      db.delete(executionChecklist).where(eq(executionChecklist.id, 1)).run();
      return db
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
        .returning()
        .get();
    }
    return db.update(executionChecklist).set(patch).where(eq(executionChecklist.id, 1)).returning().get();
  }
}

export const storage = new DatabaseStorage();
