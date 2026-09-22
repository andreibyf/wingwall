# Suggested checklist evidence

The Strategy page displays read-only suggested values beside the existing review controls. It never applies GO answers, saves a review, arms entries, changes automation mode, or creates a position.

## Sources and timestamps

- Cached Gexbot signed net GEX supplies the gamma regime. Flip and positive/negative GEX levels supply reference context, not hold/path confirmation.
- Source observation time and cache retrieval time remain separate. A new retrieval never makes an old observation fresh.
- Gexbot observations older than 30 minutes are marked stale under a suggestion-specific policy. This is not trading authorization.
- Cboe snapshots remain explicitly delayed/unverified even with a recent timestamp; observations older than two minutes are stale.
- An optional matching recommendation draft supplies proposed direction and expiration. Its recorded timestamp is a proposal timestamp, not a market observation.
- Matching draft contracts can supply strike, IV, bid/ask, volume and open-interest context. A selected expiration enables an illustrative ATM-IV expected move using calendar days/365.
- Missing feeds, invalid timestamps, unavailable contracts and unsupported indicators stay unknown. There is no fallback to invented evidence.

## Endpoint and safeguards

`GET /api/strategy/evidence?symbol=QQQ&strategy=butterfly&draftId=1`

The endpoint requires existing operator authentication, validates query input, rejects mismatched or missing selected drafts, returns `Cache-Control: no-store`, and performs no database writes. Gamma data comes from the existing cache without consuming a provider refresh. Feed failures return explicit missing evidence.

The panel refreshes every minute while mounted. It hides a previous successful response if refresh fails. Switching symbol or strategy clears the draft selection. Refreshing suggestions does not alter manual review answers.

## Known gaps

No new feed is connected. VWAP, trend, moving averages, momentum, flip-chop, volatility regime, event risk, historical IV rank and complete risk/reward approval still need additional data, rules, or explicit review. Delayed evidence cannot satisfy fresh-quote automation requirements.

## Verification

Run `npm run test:evidence`, `npm run test:automation`, `npm run test:strategy`, `npm run test:copilot`, `npm run check` and `npm run build`. Integration coverage verifies authentication, no-store responses, feed failure, draft mismatch and unchanged review/settings/position state.
