# Duplicate wall resolution

The Campaign page detects multiple walls for the selected symbol and current week.
The operator selects a keeper, reviews the IDs to remove, and confirms.
Removed wall values and notes are not merged. Linked flies are reassigned to the keeper.

## Verification performed

- `npm run check`: passed.
- `npm run build`: passed (existing bundle-size and PostCSS warnings).
- `git diff --check`: passed.
- Isolated Playwright UI checks: selection required; ambiguous save blocked; cancellation returns to selection; HTTP 409 clears selection; successful resolution retains selected values, removes the warning, and enables saving.
- Desktop 1440px and mobile 375px screenshots reviewed. Resolution controls fit without horizontal overflow.

## PostgreSQL integration results

The real HTTP routes and storage implementation were tested against disposable
PostgreSQL 18.6 databases on September 20, 2026. All 20 integration tests passed.
Three additional consecutive full-suite runs passed (60/60 checks), and the
remote-host refusal guard was separately verified. TypeScript, production build,
and diff checks were rerun successfully after adding the suite.
No production data or orders were changed. Browser tests remain separately
identified as fixture-based UI tests.

Verified:

- Two or more walls resolve to the selected keeper, preserving all keeper fields.
- Both open and closed flies are reassigned; unrelated and unlinked flies are unchanged.
- Other symbols and weeks remain unchanged.
- Missing keeper, wrong symbol/week, unknown duplicate, newly added duplicate, and
  changed grouping return 409 without writes.
- Eight malformed-selection cases return 400 without writes.
- An injected PostgreSQL deletion-trigger failure rolls back the earlier fly
  reassignment; retry succeeds after the failure is removed.
- Conflicting concurrent resolutions produce exactly one success and one 409,
  with all affected flies linked to the winner.
- Replaying a completed resolution returns 409 without additional writes.
- Resolution waits for an in-flight insert transaction to commit, then rejects
  the now-stale review without changing committed data.

### Rerun

Provide a disposable local PostgreSQL server and a role allowed to create databases:

```sh
TEST_DATABASE_URL=postgresql://localhost:55432/postgres npm run test:db
```

The default URL is the same as the example. Set the username, password, or port
in `TEST_DATABASE_URL` if your local server requires them.
The runner rejects remote hosts, URL options, and maintenance database names
other than `postgres`. It does not use the application's `DATABASE_URL`.
It creates a unique `wingwall_test_*` database, runs the production schema
bootstrap and HTTP routes, closes all pools, and drops only its own test database.
It never starts the production server or calls live pricing/trading endpoints.

The suite uses Node's test runner through the existing `tsx` dependency.
Tests run sequentially; concurrency is explicitly exercised inside the relevant tests.

This change repairs existing duplicate groups on demand. It does not add a database
uniqueness constraint or prevent future duplicates created by concurrent writers.
Stale-review detection compares group membership, not changes to individual wall
values or notes. Tests do not claim production Render configuration or load testing.

## Isolated UI demo

Run `npm run build`, then `node preview.mjs`, and open `http://localhost:5000/#/campaign`.
This demo uses in-memory QQQ walls; restarting it restores the fixtures.
Live API services are intentionally unavailable.
