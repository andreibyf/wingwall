import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import type * as z from "zod/mini";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// A single fly (debit butterfly / broken-wing butterfly) position.
export const flies = sqliteTable("flies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(), // QQQ | SPY
  optionType: text("option_type").notNull(), // call | put
  structureType: text("structure_type").notNull().default("symmetric"), // symmetric | bwb
  expiration: text("expiration").notNull(), // YYYY-MM-DD
  lowerStrike: real("lower_strike").notNull(),
  middleStrike: real("middle_strike").notNull(),
  upperStrike: real("upper_strike").notNull(),
  contracts: integer("contracts").notNull().default(1),
  entryDebit: real("entry_debit").notNull(), // per-share debit paid
  entryDate: text("entry_date").notNull(), // YYYY-MM-DD
  status: text("status").notNull().default("open"), // open | closed
  exitDebit: real("exit_debit"), // per-share credit received on close (nullable)
  exitDate: text("exit_date"),
  maxLoss: real("max_loss").notNull(), // dollars, = basis for R
  maxProfit: real("max_profit").notNull(), // dollars, theoretical ceiling
  campaignWallId: integer("campaign_wall_id"),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
});

export const insertFlySchema = createInsertSchema(flies).omit({
  id: true,
  createdAt: true,
});

export type InsertFly = z.infer<typeof insertFlySchema>;
export type Fly = typeof flies.$inferSelect;

// One weekly campaign "wall" key per symbol.
export const campaignWalls = sqliteTable("campaign_walls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  symbol: text("symbol").notNull(),
  weekOf: text("week_of").notNull(), // Monday date, YYYY-MM-DD
  wallPrice: real("wall_price").notNull(),
  referenceClose: real("reference_close"),
  activeBranch: text("active_branch").notNull().default("pending"), // pending | rejects | grinds | breaks
  gapPercent: real("gap_percent"), // Wed-night gap vs wall, if re-keyed
  reKeyed: integer("re_keyed", { mode: "boolean" }).notNull().default(false),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
});

export const insertCampaignWallSchema = createInsertSchema(campaignWalls).omit({
  id: true,
  createdAt: true,
});

export type InsertCampaignWall = z.infer<typeof insertCampaignWallSchema>;
export type CampaignWall = typeof campaignWalls.$inferSelect;

// Single-row settings table (upsert pattern, id is always 1).
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  accountBalance: real("account_balance").notNull().default(1000),
  riskPerTradePercent: real("risk_per_trade_percent").notNull().default(10),
  defaultSymbol: text("default_symbol").notNull().default("QQQ"),
});

export const insertSettingsSchema = createInsertSchema(settings).omit({
  id: true,
});

export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settings.$inferSelect;

// Execution checklist state for the current active week (single row, id=1).
export const executionChecklist = sqliteTable("execution_checklist", {
  id: integer("id").primaryKey(),
  weekOf: text("week_of").notNull(),
  noEarlyFills: integer("no_early_fills", { mode: "boolean" }).notNull().default(false),
  workingWindowRespected: integer("working_window_respected", { mode: "boolean" }).notNull().default(false),
  clippedSizing: integer("clipped_sizing", { mode: "boolean" }).notNull().default(false),
  blockedStrikesVerified: integer("blocked_strikes_verified", { mode: "boolean" }).notNull().default(false),
  fillsLogged: integer("fills_logged", { mode: "boolean" }).notNull().default(false),
  thursdayReserveDeployed: integer("thursday_reserve_deployed", { mode: "boolean" }).notNull().default(false),
  fridayCurfewRespected: integer("friday_curfew_respected", { mode: "boolean" }).notNull().default(false),
});

export const insertExecutionChecklistSchema = createInsertSchema(executionChecklist).omit({
  id: true,
});

export type InsertExecutionChecklist = z.infer<typeof insertExecutionChecklistSchema>;
export type ExecutionChecklist = typeof executionChecklist.$inferSelect;
