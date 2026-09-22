# Paper decisions and learning loop

This extends the mentor checklist release at the operator's request: instructional trade guidance, automatic paper entry/exit decisions, outcome tracking and learning from recorded experience. No broker orders are placed. This implementation does not turn on production paper mode or the master entry switch.

## Teaching and recorded experience

The Strategy learning panel presents before-entry, during-trade and after-exit guidance. Copilot is instructed to explain strategy fit versus waiting, evidence and unknowns, thesis, invalidation, entry trigger/limit, size, full-debit risk including costs, target, stop, time exit and next observations. Numbers must come from the desk snapshot.

The PostgreSQL spread ledger records immutable entry evidence, review, numeric trigger, quote timestamp, thesis, size and policy version. The decision log records entries, exits, waits, missing data and configuration changes. Saved user reflections become future Copilot context. Butterfly history remains available through the existing journal and snapshot.

This is retrieval of recorded experience, not weight training. There is no optimizer, automatic rule rewrite or claim of improved profitability. Suggestions to change rules require operator review. Small samples, hindsight and selection bias are explicitly called out.

## Explicit paper experiment policies

These are Wingwall policies, not inferred mentor instructions:

- Each saved plan must have a separate enabled configuration with one numeric underlying price threshold per layer. Free-text triggers are documentation, not interpreted executable rules.
- Entries require `PAPER_AUTOMATION_MODE=paper`, configured operator authentication, Settings auto-entry enabled, a current matching directional GO checklist, supported market calendar and fresh timezone-qualified quotes no older than two minutes.
- Entry window is Monday–Wednesday 09:45–10:30 Eastern. No expiration-day entries. The existing exchange calendar must support the expiration.
- At most one new layer per evaluation; ten minutes between layers. Existing layers must have positive net liquidation P&L before adding. After any layer exits, no further layers may enter that campaign.
- Numeric threshold alone does not verify all qualitative checklist evidence. The 30-minute review expiry remains enforced; absent refreshed evidence blocks unattended entries rather than auto-passing.
- Entry limit is the plan's debit. Simulated entry uses long ask minus short bid plus configured slippage; liquidation uses long bid minus short ask minus slippage. Both legs require valid positive uncrossed quotes; unavailable/stale quotes block writes.
- Default experimental costs: $0.65 per contract per leg per side and $0.02 spread slippage per share per side. These are configurable assumptions, not broker fee claims.
- Current executable, cost-adjusted planned reward/risk must remain at least 1.5. Full debit plus entry fees must fit the plan risk cap and the account risk budget combined with all open spread and butterfly risk.
- A butterfly cannot open while any spread is open. A configured spread can enter alongside a butterfly only within the aggregate risk cap.
- Each spread layer exits on its frozen target, stop or 15-minute-before-expiry-close curfew. This is per-layer management, not a basket stop. It does not automatically interpret narrative invalidation or live gamma changes.
- The master entry switch, per-plan disable and expired/failed reviews never disable exit checks. Exits still require paper mode, operator configuration, enabled paper exits and fresh quotes. Expired contracts are flagged for manual settlement, never fabricated.
- Policy/cost edits are rejected after first entry, except enable/disable. A new experiment requires a new plan.

## Ledger and operations

`PAPER_ENTRY_ENABLED=false` is an explicit deployment lock. Startup persists the master entry switch as off, settings cannot rearm it, and both automatic entry paths reject writes. Removing the lock later does not itself rearm the stored switch. The health endpoint reports `entryArmed` and `entryLocked` without exposing account data.

Unique `(plan_id, layer_index)` keys and transaction locks prevent duplicate fills. The existing once-per-minute advisory-locked scheduler invokes the spread worker, including when the browser is closed. The provider chain is fetched once per symbol per worker run. Repeated decision writes within a minute are deduplicated.

The learning panel reports spread realized net P&L, closed/open count, win rate and profit factor, including fees on both sides. Marks retain their timestamps and are not presented as current when unavailable. Butterfly metrics remain in Overview; neither screen claims to be a combined account total. Paper results do not guarantee achievable fills or an edge.

Observe mode records would-enter/would-exit without creating fills. The hosted preview is a separate fixture with no worker or production database. No production settings are changed by this release. A delayed feed cannot satisfy freshness merely because trading is simulated.

## Verification

123 tests passed: 61 automation policy/database tests, 20 existing database tests, 22 Copilot tests, 16 strategy tests and 4 learning-policy tests. TypeScript and production build passed.

Tests cover concurrent entry idempotence, conservative pricing, costs/net P&L, stale and wrong-symbol quotes, absent legs, missing/expired reviews, disabled entry switches, risk ceilings, no averaging down, layer spacing, no adds after exits, independent target/stop/expiry exits, expired settlement flags, authentication, saved reflections and immutable post-entry policy.

Browser QA covers instructional panels, saving disabled numeric rules, simulated ledger display, reflection persistence after reload, and desktop/mobile fit. Database fixtures are isolated on localhost and never copied to production.
