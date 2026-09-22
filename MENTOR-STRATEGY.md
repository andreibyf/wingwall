# Mentor checklists and layered debit-spread planning

## Source and scope

Based on the operator's supplied `butterfly-checklist.pdf` and `debit-spread-checklist.pdf`, each one page, received September 21, 2026. The originals are not committed to GitHub. The in-app checklists paraphrase all twelve checks in each document, including suggested evidence sources. This is an implementation of the supplied educational checklist, not a claim that its strategy is profitable.

The Strategy tab provides separate butterfly and debit-spread reviews, explicit GO / NO-GO / unknown answers, written evidence, an audit history in PostgreSQL, and saved multi-layer debit-spread scenarios. No external feed is connected by this feature. Observations are operator-entered and are not independently verified.

## Mentor rules represented

- Butterfly: gamma first; standard beginner butterfly is blocked in negative gamma. Price must clearly hold the positive-gamma side of the flip. Volatility, trend, VWAP, moving averages, momentum, target/body reachability, support/resistance, expiration, planned payoff and event risk are reviewed.
- Debit spread: may be considered in either gamma regime, but negative gamma requires stronger directional confirmation. Review direction, VWAP, momentum, path to the short strike, strike selection, IV, expected move, payoff, expiration, liquidity and event risk.
- Flip-zone chop means wait. A rejected butterfly is never treated as permission for a debit spread.
- Approximately 1.5:1 or better is about planned management. The spread planner calculates both theoretical maximum economics and planned target/stop economics.

## Explicit Wingwall implementation choices

These are conservative application policies, not extra rules attributed to the mentor:

- Every checklist row must be GO. Any NO-GO/caution blocks that strategy; unanswered evidence is incomplete.
- A saved review expires in 30 minutes, and should be redone sooner when conditions change. A new review supersedes the old one, including a new NO-GO.
- New open butterfly records require a current GO review, including manual entry. The scheduled entry path checks before fetching a chain/model and rechecks under transaction locks at commit. It records the review ID in its journal.
- Existing position exits remain available even if reviews expire or turn NO-GO. Open-position structure/size edits cannot bypass entry controls; close and create a reviewed replacement. Historical closed-record entry remains available.
- A review is a strategy-level operator attestation, not automated verification of live indicators or approval of every possible strike combination. Existing structure, price and timing guards still apply.

## Layer planning, not execution

The documents do not define how many layers, when to add them, spacing, sizing progression, averaging-down permissions or campaign-level exit policy. No automatic entry or layer-management rules have been invented.

The planner supports bullish call debit spreads and bearish put debit spreads on QQQ/SPY (100 multiplier). Each layer has expiration, ordered long/short strikes, contracts, debit, target credit, stop credit and a written entry/add trigger. The operator declares a total full-debit risk cap and a layer-count limit (default one; UI validation ceiling ten, not a trading recommendation).

The server validates direction, strike order, real calendar dates, debit/target/stop bounds, integer contracts, planned reward/risk >=1.5 and aggregate risk against the declared cap. It stores each scenario in PostgreSQL and flags when existing open butterfly risk plus the whole scenario exceeds the configured account risk budget.

Full debit is the maximum-loss risk basis: a planned stop is not guaranteed. Fees and slippage are not modeled. Summing per-layer maximum profits is not a guarantee those maxima can be realized together, especially with different expirations. Alternative saved plans do not reserve capital. Past-expiry hypothetical plans may be saved for study; nothing executes them.

Plans remain clearly marked `plan_only`. They do not create ledger positions or affect Overview P&L, win rate, account deployment or the butterfly worker. A plan can be saved with a failed/missing review for study; this is never execution permission. Review status recorded at save is historical, not current approval.

Copilot receives current review status and recent plans, with instructions not to claim that plans are positions or that workers execute/manage them.

## Verification and release

Run `npm run check`, `npm run test:strategy`, `npm run test:automation`, `npm run test:db`, `npm run test:copilot`, and `npm run build`. PostgreSQL suites use isolated disposable localhost databases, never production.

Browser verification covers both strategy forms, negative-gamma and flip-chop decisions, review persistence, spread economics, two-layer saving, reload persistence, and mobile layout. Production observation mode and the entry switch are not changed by this feature.

Release verification: 105 automated tests passed (16 strategy policy, 47 automation including database integration, 20 existing database and 22 Copilot tests). TypeScript and production build passed. Database-backed browser checks verified negative-gamma rejection, directional confirmation, a saved two-layer plan surviving reload, and desktop/mobile layouts without document overflow. The attached hosted preview is an isolated fixture, not the production database.

Before implementing spread execution, confirm the mentor's layer count, add trigger, size progression, total campaign risk, and per-layer versus basket exit rules. Also complete fresh-feed readiness. The uploaded checklists alone are insufficient authorization for unattended spread execution.
