# Copilot empty-response recovery

## Investigation update

The subsequent direct-provider investigation reproduced token exhaustion with
1,400 thinking tokens and zero answer characters. See
[COPILOT-ROOT-CAUSE.md](COPILOT-ROOT-CAUSE.md) for the controlled comparison,
provider message IDs, historical-evidence limits, and corrective recommendation.
This PR is still unmerged and must be revised beyond mitigation before rollout.

## Confirmed defect

The old chat handler converted upstream responses without text blocks into a
successful `{ reply: "(empty response)" }`. The widget appended that literal
placeholder to the conversation and sent it back on subsequent turns.
The user's screenshot showed this behavior twice on follow-up messages.

The original provider payload was not retained, so its precise reason for
returning no text is unknown. Token exhaustion is handled as one possible cause,
not claimed as the established root cause.

## Changes

- Missing, blank, malformed, thinking-only, or placeholder answers raise a
  retryable HTTP 502 instead of becoming assistant messages.
- Only when an empty reply explicitly reports `stop_reason: max_tokens`, retry
  once with a larger budget: at least 4096, at most 8192 tokens. An already larger
  configured budget is not reduced. This retry can incur another provider charge.
- Preserve the same fresh snapshot and history through that retry.
- Remove old assistant placeholders from outbound conversation history.
- Log only response metadata (stop reason, block types, output-token count,
  budget, attempt). Never log response content or hidden reasoning in this helper.
- Client rejects empty or malformed success payloads and preserves the user's
  unanswered turn for Retry. Clear is disabled while a request is pending.
- No model change, trading action, database change, or gatekeeper change.

## Verification

`npm run test:copilot`: 13 tests pass, covering malformed responses, text-only
extraction, bounded retries, provider errors, and the actual chat follow-up
request path with a mocked provider.

`npm run check`, `npm run build`, and `git diff --check` pass.
Existing build warnings concern PostCSS and bundle size.

Playwright checks against isolated fixtures pass:

- Legacy empty placeholder produces error UI, not an assistant bubble.
- HTTP 502 is readable and retryable.
- Repeated Retry requests preserve the original user turn exactly.
- Successful retry shows the answer and clears the error.
- Clear is disabled while pending.
- Desktop 1280px and mobile 375px inspected; no horizontal overflow.

These are deterministic regression tests, not a claim that the live provider
issue was reproduced or repaired in production. After deployment, reload the
widget and test a normal question followed by “yes.” If the upstream provider
continues returning empty content, inspect the new metadata to diagnose it.
