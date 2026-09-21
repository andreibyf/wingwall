# Copilot root-cause fix verification

## Implemented policy

- Sonnet 5 chat explicitly requests adaptive thinking and high effort.
- Chat defaults to 8192 output tokens, shared between reasoning and answer.
  Legacy lower limits or invalid settings fall back to 8192; valid larger
  configured budgets up to 128000 are honored.
- No automatic second model request.
- Only a nonempty text answer with `stop_reason: end_turn` is treated as complete.
  Token-limited answers are withheld even when text is present.
- Safe provider metadata is logged; thinking content is not.
- Old assistant placeholders are filtered from outbound history; client Retry
  preserves the unanswered user message.
- `/api/copilot/status` exposes the effective `chatPolicy` for verification.
- `callModelOnce`, the automated gatekeeper, and trading rules are unchanged.
  The separate gatekeeper token-budget concern remains outside this chat fix.

## Verification before merge

- 22 regression tests passed via `npm run test:copilot`.
- Actual chat request assertions verify the 8192 budget, adaptive thinking,
  high effort, snapshot preservation, and exactly one provider request.
- Regression test verifies gatekeeper request remains at its existing 1200
  default without added thinking/effort fields.
- TypeScript, production build, and diff checks passed.
- Prior desktop/mobile UI checks passed for error display, retry, and successful recovery.
- Direct Anthropic test of the exact new policy returned HTTP 200 and
  `stop_reason: end_turn`: 2284 output tokens, including 1491 thinking tokens,
  and 2015 answer characters. Provider message ID:
  `msg_011CfGjb7zhZoecQ6maJbDs4`. No automatic retry was used.

See [the investigation](COPILOT-ROOT-CAUSE.md) for the earlier controlled
reproduction and its historical-evidence limitations. This fix does not assert
that every possible prompt will fit the budget; incomplete replies are surfaced
as errors rather than silently shown as complete trading advice.
