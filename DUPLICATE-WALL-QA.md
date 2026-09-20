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

## Integration checks required before production rollout

Browser tests used `preview.mjs`, an isolated fixture server, not PostgreSQL.
No production data or orders were changed.

Against a disposable PostgreSQL database, verify:

- Two walls with the same symbol/week resolve to the selected keeper.
- Every fly linked to removed IDs points to the keeper after commit.
- Other symbols/weeks and keeper fields remain unchanged.
- Missing keeper, extra/new duplicate, or changed grouping returns 409 with no writes.
- Invalid, repeated, or self-referential IDs return 400.
- A database failure rolls back both reassignment and deletion.
- Concurrent requests cannot partially resolve a group.

This change repairs existing duplicate groups on demand. It does not add a database
uniqueness constraint or prevent future duplicates created by concurrent writers.

## Isolated UI demo

Run `npm run build`, then `node preview.mjs`, and open `http://localhost:5000/#/campaign`.
This demo uses in-memory QQQ walls; restarting it restores the fixtures.
Live API services are intentionally unavailable.
