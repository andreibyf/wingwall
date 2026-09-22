# Copilot recommendation drafts

Chat can now populate editable structured recommendations when the operator asks it to prepare, save, draft or plug in a setup. Ordinary advice remains text-only. The only model tool is `save_recommendation_draft`; there are no order, execution, checklist approval, settings or automation tools.

Drafts appear in Strategy → Recommendation drafts. They support butterfly, debit-spread and wait scenarios, proposed legs, entry/layer conditions, target/stop credits, risk limits, invalidation, source evidence and missing inputs. Unknown numeric values remain null. These are unvalidated planning assumptions, not executable plans or quote attestations.

## Persistence and safety

- Dedicated PostgreSQL `recommendation_drafts` table. No worker reads it.
- Authenticated API; existing operator-origin checks apply.
- Strict schema rejects execution and approval fields.
- Only one complete, recognized tool call is handled per reply. Truncation, multiple tools or unknown tools fail without writes.
- Server confirms saving only after persistence succeeds. Model prose accompanying a tool call is not used as confirmation.
- Client request UUID and a unique database constraint prevent duplicate saves on retries.
- Edits use optimistic version checks. The original agent payload is retained separately.
- Latest drafts, including user modifications, enter future chat snapshots as planning context, never checklist evidence.
- No copy into a live plan, no automatic checkbox completion, no arming, no fills, no broker order calls.
- This is on-request drafting, not a background recommendation scheduler. Feed freshness remains a separate blocker for execution readiness.

## Verification

Unit tests cover null fields, forbidden execution flags, completed tool calls, truncated/unknown/multiple tools and database failure propagation. Database integration covers persistence, concurrent retry deduplication, authentication, edit conflicts, original-payload retention, model-to-draft handoff and unchanged trading state.

Browser QA checklist: chat creates a demo draft; Strategy navigation; edit and save fields and legs; discard unsaved edits; reload persistence; audit copy remains unchanged; unknown prices stay blank; desktop/mobile fit; no execution controls in the draft editor. Off-happy-path checks include invalid numeric inputs and conflicting edits.
