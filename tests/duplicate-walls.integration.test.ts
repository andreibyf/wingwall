import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import express from "express";
import { Pool } from "pg";

// Never accept the application's DATABASE_URL as the test target.
const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://localhost:55432/postgres");
assert.equal(url.hostname, "localhost", "Tests require a disposable localhost PostgreSQL server");
assert.ok(!url.search, "Connection URL options are not accepted");
assert.equal(url.pathname, "/postgres", "Connect to the local maintenance database");
const database = `wingwall_test_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: url.toString(), ssl: false });
let sql: Pool;
let appPool: Pool;
let server: Server;
let base: string;
let created = false;

before(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.toString();
  sql = new Pool({ connectionString: url.toString(), ssl: false });
  const { ensureSchema, db } = await import("../server/storage.ts");
  appPool = db.$client;
  await ensureSchema();
  const { registerRoutes } = await import("../server/routes.ts");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  await registerRoutes(server, app);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ message: err.message });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await appPool?.end();
  await sql?.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

beforeEach(async () => {
  await sql.query("DROP TRIGGER IF EXISTS fail_delete ON campaign_walls");
  await sql.query("TRUNCATE flies, campaign_walls RESTART IDENTITY");
  // ensureSchema now creates a unique index on (symbol, week_of), which makes new duplicates
  // impossible. These fixtures model a LEGACY database whose duplicates predate that index -- the
  // case resolution exists for -- so the index is dropped first. The tests at the end of this file
  // cover the index itself.
  await sql.query("DROP INDEX IF EXISTS campaign_walls_symbol_week_uniq");
  await sql.query(`
    INSERT INTO campaign_walls
      (symbol, week_of, wall_price, reference_close, active_branch, gap_percent, re_keyed, notes, created_at)
    VALUES
      ('QQQ', '2026-09-14', 725, 710, 'pending', NULL, false, 'first notes', '2026-09-14'),
      ('QQQ', '2026-09-14', 730, 712, 'rejects', 1.5, true, 'keeper notes', '2026-09-15'),
      ('SPY', '2026-09-14', 650, 640, 'grinds', NULL, false, 'other symbol', '2026-09-14'),
      ('QQQ', '2026-09-21', 740, 720, 'breaks', NULL, false, 'other week', '2026-09-21');
    INSERT INTO flies
      (symbol, option_type, expiration, lower_strike, middle_strike, upper_strike,
       entry_debit, entry_date, max_loss, max_profit, campaign_wall_id, status, created_at)
    SELECT 'QQQ', 'put', '2026-09-18', 710, 715, 720, 0.3, '2026-09-14',
      30, 470, wall_id, status, '2026-09-14'
    FROM (VALUES (1, 'open'), (1, 'closed'), (2, 'open'), (3, 'open'), (NULL::int, 'open')) AS f(wall_id, status);
  `);
});

async function resolve(body: unknown) {
  const response = await fetch(`${base}/api/campaign/resolve-duplicates`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function snapshot() {
  return {
    walls: (await sql.query("SELECT * FROM campaign_walls ORDER BY id")).rows,
    flies: (await sql.query("SELECT * FROM flies ORDER BY id")).rows,
  };
}
async function unchanged(body: unknown, status: number) {
  const before = await snapshot();
  assert.equal((await resolve(body)).status, status);
  assert.deepEqual(await snapshot(), before);
}

test("keeps exact selected fields, reassigns open and closed flies, preserves unrelated rows", async () => {
  const before = await snapshot();
  assert.deepEqual(await resolve({ keepId: 2, duplicateIds: [1] }), {
    status: 200, body: { keepId: 2, removed: 1 },
  });
  const after = await snapshot();
  assert.deepEqual(after.walls, before.walls.filter((w) => w.id !== 1));
  assert.deepEqual(after.flies, before.flies.map((f) => ({
    ...f, campaign_wall_id: f.campaign_wall_id === 1 ? 2 : f.campaign_wall_id,
  })));
});

test("resolves more than two walls with unsorted duplicate IDs", async () => {
  await sql.query("INSERT INTO campaign_walls (symbol, week_of, wall_price, created_at) VALUES ('QQQ', '2026-09-14', 735, '2026-09-16')");
  assert.equal((await resolve({ keepId: 2, duplicateIds: [5, 1] })).status, 200);
  assert.deepEqual((await snapshot()).walls.map((w) => w.id), [2, 3, 4]);
});

for (const [name, body] of [
  ["missing keeper", { keepId: 999, duplicateIds: [1] }],
  ["wrong symbol", { keepId: 2, duplicateIds: [3] }],
  ["wrong week", { keepId: 2, duplicateIds: [4] }],
  ["unknown duplicate", { keepId: 2, duplicateIds: [999] }],
] as const) {
  test(`rejects ${name} without writes`, () => unchanged(body, 409));
}

test("rejects a newly added duplicate not included in the review", async () => {
  await sql.query("INSERT INTO campaign_walls (symbol, week_of, wall_price, created_at) VALUES ('QQQ', '2026-09-14', 735, '2026-09-16')");
  await unchanged({ keepId: 2, duplicateIds: [1] }, 409);
});

test("rejects a duplicate whose grouping changed since review", async () => {
  await sql.query("UPDATE campaign_walls SET week_of = '2026-09-21' WHERE id = 1");
  await unchanged({ keepId: 2, duplicateIds: [1] }, 409);
});

for (const [name, body] of [
  ["missing fields", {}],
  ["empty duplicates", { keepId: 2, duplicateIds: [] }],
  ["repeated IDs", { keepId: 2, duplicateIds: [1, 1] }],
  ["self-reference", { keepId: 2, duplicateIds: [2] }],
  ["string ID", { keepId: "2", duplicateIds: [1] }],
  ["negative ID", { keepId: -2, duplicateIds: [1] }],
  ["fractional ID", { keepId: 2.5, duplicateIds: [1] }],
  ["null duplicate", { keepId: 2, duplicateIds: [null] }],
] as const) {
  test(`validates ${name} without writes`, () => unchanged(body, 400));
}

test("rolls back fly reassignment when deletion fails, then allows a retry", async () => {
  await sql.query(`
    CREATE OR REPLACE FUNCTION reject_wall_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected integration failure'; END $$;
    CREATE TRIGGER fail_delete BEFORE DELETE ON campaign_walls
      FOR EACH ROW EXECUTE FUNCTION reject_wall_delete();
  `);
  await unchanged({ keepId: 2, duplicateIds: [1] }, 500);
  await sql.query("DROP TRIGGER fail_delete ON campaign_walls");
  assert.equal((await resolve({ keepId: 2, duplicateIds: [1] })).status, 200);
});

test("serializes conflicting resolutions with exactly one winner and no orphaned links", async () => {
  const outcomes = await Promise.all([
    resolve({ keepId: 2, duplicateIds: [1] }),
    resolve({ keepId: 1, duplicateIds: [2] }),
  ]);
  assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
  const winner = outcomes.find((r) => r.status === 200)!.body.keepId;
  const data = await snapshot();
  assert.deepEqual(data.walls.filter((w) => w.symbol === "QQQ" && w.week_of === "2026-09-14").map((w) => w.id), [winner]);
  assert.ok(data.flies.slice(0, 3).every((f) => f.campaign_wall_id === winner));
});

test("repeated resolution returns conflict without changing committed data", async () => {
  assert.equal((await resolve({ keepId: 2, duplicateIds: [1] })).status, 200);
  await unchanged({ keepId: 2, duplicateIds: [1] }, 409);
});

test("waits for an in-flight insert, then rejects the stale review", async () => {
  const writer = await sql.connect();
  let pending: ReturnType<typeof resolve> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("INSERT INTO campaign_walls (symbol, week_of, wall_price, created_at) VALUES ('QQQ', '2026-09-14', 735, '2026-09-16')");
    pending = resolve({ keepId: 2, duplicateIds: [1] });
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const result = await sql.query(`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE 'LOCK TABLE campaign_walls%'`);
      if (result.rowCount) { waiting = true; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(waiting, "resolution must wait on the writer's lock");
    await writer.query("COMMIT");
    const committed = await snapshot();
    assert.equal((await pending).status, 409);
    assert.deepEqual(await snapshot(), committed);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
    await pending;
  }
});


// ---- Uniqueness going forward ------------------------------------------------------------------

const UNIQ = "campaign_walls_symbol_week_uniq";
async function indexExists() {
  return (await sql.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [UNIQ])).rowCount === 1;
}
async function postWall(body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/campaign`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("ensureSchema skips the unique index while duplicates exist, then creates it once resolved", async () => {
  const { ensureSchema } = await import("../server/storage.ts");
  await ensureSchema();
  assert.equal(await indexExists(), false, "index must not be created over existing duplicates");
  assert.equal((await resolve({ keepId: 2, duplicateIds: [1] })).status, 200);
  await ensureSchema();
  assert.equal(await indexExists(), true, "index must be created once the week is unambiguous");
  await assert.rejects(
    sql.query("INSERT INTO campaign_walls (symbol, week_of, wall_price, created_at) VALUES ('QQQ', '2026-09-14', 999, 'x')"),
    /campaign_walls_symbol_week_uniq/,
  );
});

test("POST /api/campaign updates an existing week in place instead of inserting a duplicate", async () => {
  await sql.query("DELETE FROM campaign_walls WHERE id = 1");
  const { ensureSchema } = await import("../server/storage.ts");
  await ensureSchema();
  assert.equal(await indexExists(), true);
  const wall = { symbol: "QQQ", weekOf: "2026-09-21", wallPrice: 745, referenceClose: 721,
    activeBranch: "rejects", gapPercent: null, reKeyed: false, notes: "re-keyed" };
  const updated = await postWall(wall);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.id, 4);
  assert.equal(updated.body.wallPrice, 745);
  const rows = (await sql.query("SELECT id FROM campaign_walls WHERE symbol = 'QQQ' AND week_of = '2026-09-21'")).rows;
  assert.deepEqual(rows.map((r) => r.id), [4]);
});

test("POST /api/campaign still creates a wall for a week that has none", async () => {
  const created = await postWall({ symbol: "QQQ", weekOf: "2026-09-28", wallPrice: 750, referenceClose: null,
    activeBranch: "pending", gapPercent: null, reKeyed: false, notes: null });
  assert.equal(created.status, 201);
  assert.equal(created.body.weekOf, "2026-09-28");
});
