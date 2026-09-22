# Paper automation: deployment and verification

## Scope and safe defaults

Workers execute inside the always-on Wingwall web service, independently of browser tabs. A PostgreSQL advisory lock elects one active runner, minute-bucket run keys make wakes repeat-safe, and transactional entry claims and close transitions prevent duplicate paper writes. This is not a broker integration and never submits broker orders.

Default mode is `observe`: the worker records eligible proposals and exit decisions without changing positions. The existing database entry switch is preserved; this implementation does not turn it on.

## Required deployment configuration

- `WINGWALL_OPERATOR_PASSWORD`: a new private passphrase, at least 16 characters, set through Render Environment. Never commit it or send it in chat. Missing/short configuration locks private APIs, not anonymous access.
- `PAPER_AUTOMATION_MODE=observe`: initial default until an authenticated operator explicitly selects a mode in Settings. A persisted UI selection takes precedence over this default; do not use this variable as an emergency override.
- `PAPER_AUTOMATION_FORCE_OBSERVE=true`: deployment-level emergency override, always wins over the UI and blocks paper mode selection.
- `PAPER_EXIT_ENABLED=true`: independent of the entry switch. In observe mode this does not authorize closure. `false` blocks automatic closure even in paper mode.
- Existing database/model variables remain unchanged. `CRON_SECRET` remains restricted to the legacy peak endpoint; it cannot access settings or entry execution.

Deployment prerequisite: confirm the operator passphrase is configured before merging, otherwise the app will intentionally lock access. Do not put the password in a PR, logs, URL, fixture, or source.

The Settings panel shows mode, entry arm state, exit enable state, heartbeat, recent runs, and alerts. Operator cookies are HTTP-only, secure in production, SameSite=Strict, expire after 12 hours, and become invalid if the configured password changes. Login attempts are database rate-limited. API writes reject cross-origin browser requests. All private API reads and mutations require login.

## Schedule and data policy

- Workers wake every 60 seconds and use a database lock; they do not depend on a browser or a Computer session.
- Entries are evaluated at most once per five minutes within Monday–Wednesday 09:45 inclusive to 10:30 exclusive, America/New_York.
- Exchange holidays and early closes are explicitly bounded to 2026–2027. Outside those years, or where Thursday is a holiday, automatic entry fails closed pending calendar review.
- Entry requires a same-symbol, current-week campaign, available risk budget, no open position, and no prior entry for that symbol/campaign week.
- Paper closes evaluate configured profit/loss thresholds, expiry-day curfew 15 minutes before the equity close, and Friday curfew at 14:00 Eastern or 15 minutes before an early close, whichever is earlier.
- Already-expired positions require manual settlement; workers do not invent settlement prices.
- Quotes must carry a provider timestamp with a timezone, no more than two minutes old and no more than 30 seconds in the future. Missing/stale quotes cause no write and an alert.
- The current Cboe source is delayed. A 15-second cache does not make it real time. The IBKR connector currently has no verified provider timestamp and is skipped on Render. Both facts can legitimately prevent autonomous writes until an eligible feed is integrated.
- All automatic fills are explicitly simulated mids, never claims of executable broker fills.

Calendar source: [NYSE/ICE published calendar](https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx). The implementation deliberately uses equity session closes rather than the extra options minutes.

## Health, alerts, and legacy task

`GET /health/automation` exposes only aggregate health/mode and returns 503 when a recent completed worker run is unavailable, stale, or degraded. Authenticated `GET /api/automation/status` includes the last ten run details. Run history is retained 30 days. Alerts are persisted in run records, displayed in Settings, and logged as structured errors.

This release does not provision an external email/push monitor. For alerts while the entire web service is down, configure an independent monitor against `/health/automation`; a worker cannot notify from inside a stopped process. Do not use this degradation endpoint as a restart liveness probe: missing quotes should raise an alert, not cause restart loops.

The old Render peak task is not the new execution worker. Replace its start command with `node script/track-peaks.mjs`, or retire it once peak sampling is otherwise covered. The replacement script uses a request timeout, rejects HTTP failures, and checks the business result; the old inline command falsely treated HTTP errors as success. Merely merging this PR does not change that separately stored Render command.

## Failure and recovery behavior

Entry revalidates settings, arm state, campaign, time window, and quote freshness under database locks immediately before insertion. Position, weekly claim, and journal commit together. Closure re-reads the current position and exit policy under lock, then closes and journals atomically. Turning off entries does not disable management of open positions.

Model failure or incomplete output never grants approval. The risk gate uses explicit Sonnet thinking/output policy, a sufficient token budget, a 45-second request timeout, `end_turn` validation, and strict verdict fields. Chain requests are bounded to 20 seconds.

A worker process exit releases the database lease. Abandoned run records are marked on a later wake. Repeated wakes in the same minute do not rerun; the next eligible wake may retry decisions, but weekly claims and closed-state checks prevent duplicate committed actions.

To stop new entries while retaining paper exits, turn Auto entry off in Settings. To stop automatic simulated entries AND exits, select Observe in Settings and confirm the warning. For a deployment-level emergency override, set `PAPER_AUTOMATION_FORCE_OBSERVE=true` and redeploy. Observe leaves existing positions open; it is not a liquidation command or exit protection. Reverting code alone does not remove the additive run/claim tables.

## UI mode selector

Settings → Paper-worker readiness now includes Observe / Paper automation, effective mode, configuration source, deployment entry-lock status and global entry blockers. Quote freshness and checklist readiness are deliberately not certified by the heartbeat.

Mode changes require authenticated same-origin requests, explicit effect acknowledgment and a current version. Paper selection requires a healthy worker and configured operator authentication. Either selection atomically disarms new entries and records an audit event; it does not change positions, draft recommendations, spread rules or deployment locks. Paper mode can resume exits for existing positions if exits are enabled and all execution checks pass. Existing per-plan entry rules remain configured but inactive while master entry is disarmed.

The database singleton persists across restarts. Mode writes serialize with execution through the settings lock; both butterfly and spread ledgers read effective mode inside their transactions. Database read errors fail closed. `PAPER_ENTRY_ENABLED=false` still blocks arming and entries and cannot be overridden from the UI.

Selector verification: typecheck and build pass; 134 regression tests pass (67 automation, 27 Copilot/draft, 20 duplicate-wall DB, 16 strategy, 4 learning). Tests cover authenticated and acknowledged changes, optimistic conflict rejection, startup persistence, emergency override, in-flight proposal rejection, and exit pause/resume for both workers with entries disarmed. Desktop and 375px mobile browser checks cover confirmation, cancel, save/reload, both mode directions, visible lock status and disabled entry arming. Preview mode changes are isolated fixtures, not production changes.

## QA inventory

| Claim / behavior | Verification |
|---|---|
| Private login, wrong-password error, logout | HTTP integration tests and actual local browser |
| Missing authentication configuration fails closed | HTTP integration test |
| Expired/missing session returns to sign-in | Client event handler and HTTP access tests |
| Readiness visible on desktop/mobile | Local browser Settings and screenshots |
| Observation cannot arm entries or write exits | HTTP + PostgreSQL tests; browser rejected toggle |
| DST, holidays, early closes, entry boundary, expiry/Friday curfews | Simulated-clock unit tests |
| Concurrent entry/exit exactly-once effects | Real disposable PostgreSQL concurrent calls |
| Journal failure rolls back entire operation | PostgreSQL failure-injection triggers |
| Disarm/settings/campaign changes block stale entry | PostgreSQL commit-time revalidation |
| Quotes stale/unavailable and expired settlement alert | Worker tests, no ledger mutation |
| Browser-independent worker and heartbeat | Real local server timer + run table |
| Existing duplicate resolution and chat behavior preserved | Existing integration/regression suites |

Commands: `npm run check`, `npm run test:automation`, `npm run test:db`, `npm run test:copilot`, `npm run build`.
Database suites require a localhost `/postgres` administration target with no query parameters (default `postgresql://localhost:55432/postgres`), create isolated databases, and drop them afterward. Never point them at a database tunnel to production.

Verified September 21, 2026: 40 automation checks, 20 duplicate-wall database checks, and 22 Copilot checks passed (82 total). TypeScript and production build passed. Actual local browser checks passed for wrong-password rejection, login, readiness, observe-mode arm rejection, logout, and no horizontal overflow at 1440px and 375px. The build retains non-blocking PostCSS and bundle-size warnings. This is local verification, not a claim of production deployment or fresh-feed acceptance.

Before activation, verify a production observation session and an independent heartbeat monitor, integrate eligible quote timestamps, and explicitly approve switching to paper-write mode. Keep entry disarmed until that verification is complete.
