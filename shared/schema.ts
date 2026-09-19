import { pgTable, text, integer, real, boolean, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type * as z from "zod/mini";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
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
export const flies = pgTable("flies", {
  id: serial("id").primaryKey(),
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
  // Running high-water-mark (best) / low-water-mark (worst) of unrealized P&L, expressed as a
  // fraction of maxProfit / maxLoss respectively, sampled continuously while the position is
  // open (via the server-side tracking job — see server/peakTracker.ts). Powers the Journal's
  // threshold-review table: did this trade ever cross the take-profit or stop-loss threshold
  // before it closed, regardless of what the exit debit ended up being.
  peakProfitPct: real("peak_profit_pct"),
  peakLossPct: real("peak_loss_pct"),
  createdAt: text("created_at").notNull(),
});

export const insertFlySchema = createInsertSchema(flies).omit({
  id: true,
  createdAt: true,
});

export type InsertFly = z.infer<typeof insertFlySchema>;
export type Fly = typeof flies.$inferSelect;

// One weekly campaign "wall" key per symbol.
export const campaignWalls = pgTable("campaign_walls", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  weekOf: text("week_of").notNull(), // Monday date, YYYY-MM-DD
  wallPrice: real("wall_price").notNull(),
  referenceClose: real("reference_close"),
  activeBranch: text("active_branch").notNull().default("pending"), // pending | rejects | grinds | breaks
  gapPercent: real("gap_percent"), // Wed-night gap vs wall, if re-keyed
  reKeyed: boolean("re_keyed").notNull().default(false),
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
export const settings = pgTable("settings", {
  id: integer("id").primaryKey(),
  accountBalance: real("account_balance").notNull().default(1000),
  riskPerTradePercent: real("risk_per_trade_percent").notNull().default(10),
  defaultSymbol: text("default_symbol").notNull().default("QQQ"),

  // --- Exit policy -----------------------------------------------------------
  // Previously hardcoded in shared/thresholds.ts AND duplicated independently in
  // server/copilot.ts, then restated in prose in the copilot prompt and again in the
  // threshold-watch job. Four copies of one rule; changing it meant four edits and any
  // miss left the system disagreeing with itself about when to exit. The database is now
  // the single source of truth and every consumer reads from here.
  //
  // takeProfitMode exists because "percent of max profit" is unreachable on a cheap
  // far-body fly. On the first three trades it demanded 4.2x, 5.0x and 5.4x the entry
  // debit while the best excursion ever recorded was 9.4% of max profit against a 25%
  // trigger -- the stop could fire but the target could not, so the automation could only
  // ever cut losers. Both winning exits landed at 2.17x and 2.09x the debit, so a debit
  // multiple describes the operator's actual behaviour.
  takeProfitMode: text("take_profit_mode").notNull().default("multipleOfDebit"), // multipleOfDebit | pctOfMaxProfit
  takeProfitValue: real("take_profit_value").notNull().default(2.0), // 2.0 = exit at 2x entry debit (+1.0R)
  stopLossPctOfMaxLoss: real("stop_loss_pct_of_max_loss").notNull().default(-0.4),

  // --- Structure targeting ---------------------------------------------------
  // The playbook contradicts itself here: "debit kept at roughly half the wing width
  // (~2:1 reward:risk floor)" cannot hold, since half the width is 1:1 and 2:1 needs a
  // third. The first three trades used 0.054, 0.058 and 0.072 of the width -- neither
  // documented rule. Made configurable rather than resolved by guesswork, defaulting to
  // the operator's revealed preference for the cheap convex fly.
  targetDebitToWidth: real("target_debit_to_width").notNull().default(0.06),
  maxDebitToWidth: real("max_debit_to_width").notNull().default(0.15), // reject anything richer

  // --- Autonomous trading ----------------------------------------------------
  // Off by default. Nothing enters the book unattended until explicitly switched on.
  autoTradeEnabled: boolean("auto_trade_enabled").notNull().default(false),
});

export const insertSettingsSchema = createInsertSchema(settings).omit({
  id: true,
});

export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settings.$inferSelect;

// Execution checklist state for the current active week (single row, id=1).
export const executionChecklist = pgTable("execution_checklist", {
  id: integer("id").primaryKey(),
  weekOf: text("week_of").notNull(),
  noEarlyFills: boolean("no_early_fills").notNull().default(false),
  workingWindowRespected: boolean("working_window_respected").notNull().default(false),
  clippedSizing: boolean("clipped_sizing").notNull().default(false),
  blockedStrikesVerified: boolean("blocked_strikes_verified").notNull().default(false),
  fillsLogged: boolean("fills_logged").notNull().default(false),
  thursdayReserveDeployed: boolean("thursday_reserve_deployed").notNull().default(false),
  fridayCurfewRespected: boolean("friday_curfew_respected").notNull().default(false),
});

export const insertExecutionChecklistSchema = createInsertSchema(executionChecklist).omit({
  id: true,
});

export type InsertExecutionChecklist = z.infer<typeof insertExecutionChecklistSchema>;
export type ExecutionChecklist = typeof executionChecklist.$inferSelect;

// Freeform journal log — used for tuning-experiment notes (e.g. "changed take-profit
// threshold from X% to Y% on this date") and general notes, kept separate from per-fly
// notes so it reads as a running desk log rather than being tied to one position.
export const journalNotes = pgTable("journal_notes", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(), // YYYY-MM-DD
  category: text("category").notNull().default("general"), // general | tuning-experiment
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
});

export const insertJournalNoteSchema = createInsertSchema(journalNotes).omit({
  id: true,
  createdAt: true,
});

export type InsertJournalNote = z.infer<typeof insertJournalNoteSchema>;
export type JournalNote = typeof journalNotes.$inferSelect;
