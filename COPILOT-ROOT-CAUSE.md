# Copilot empty responses: root-cause investigation

Update: the user subsequently authorized the root-cause fix. PR #2 has been
revised with explicit Sonnet 5 adaptive/high-effort thinking, an 8192-token minimum
chat budget, and rejection of truncated answers without automatic retries.
See [current verification](COPILOT-EMPTY-RESPONSE-QA.md). The text below records
the investigation state before that authorization.

Investigated September 21, 2026. PR #2 remains unmerged; no production settings,
code, positions, or walls were changed during this investigation.

## Finding

The empty-response mechanism was reproduced directly against Anthropic:
Claude Sonnet 5 spent the entire 1,400-token output allowance on thinking,
returned HTTP 200 with `stop_reason: "max_tokens"` and only a `thinking` block,
and produced zero answer characters.

Wingwall's production request omits a `thinking` setting and defaults to
`max_tokens: 1400`. Sonnet 5 enables adaptive thinking by default, unlike earlier
model behavior. Thinking and answer text share that hard output limit.
The application then filters for text blocks, obtains an empty string, and
returns the literal `(empty response)` as an HTTP-200 answer.
See the [production request and response handling](https://github.com/andreibyf/wingwall/blob/8525cb40cfd7275a5cc5d102dbde24565f20420e/server/copilot.ts)
and [Anthropic's Sonnet 5 migration guide](https://platform.claude.com/docs/en/models/sonnet-5/migration-guide).

This is a request-budget/model-default compatibility defect, not a missing
chat-rendering element. Replacing the empty message or retrying without addressing
the request configuration is insufficient. Three baseline calls returned partial
answers instead of empty ones, revealing a second symptom: silently truncated advice.

## Controlled experiment

All six successful diagnostic calls used the same production system prompt,
logged original assistant reply, original oil question, and `yes` follow-up.
One current desk snapshot was fetched once and reused across all calls.
Only the thinking setting or maximum output budget differed.

- Production source commit: `8525cb40cfd7275a5cc5d102dbde24565f20420e`.
- Snapshot fetched: `2026-09-21T12:40:50.566Z`.
- Model: `claude-sonnet-5`.
- Input tokens: 9,756 on every call.
- System/messages SHA-256: `2a63b0ebfc241b43ac92a81b0cc8a7ff950fc83b0f11c1fe7c7b6b85622b083d`.

| Test | Thinking setting | Output cap | Thinking tokens | Total output tokens | Answer characters | Stop reason |
|---|---|---:|---:|---:|---:|---|
| Baseline 1 | Omitted/default | 1,400 | 945 | 1,400 | 1,098 | max_tokens |
| Baseline 2 | Omitted/default | 1,400 | 1,197 | 1,400 | 541 | max_tokens |
| Baseline 3 | Omitted/default | 1,400 | 1,334 | 1,400 | 143 | max_tokens |
| Baseline 4 | Omitted/default | 1,400 | 1,400 | 1,400 | **0** | **max_tokens** |
| Control A | Explicitly disabled | 1,400 | 0 | 776 | 2,089 | end_turn |
| Control B | Omitted/default | 8,192 | 1,528 | 2,176 | 1,686 | end_turn |

Provider message IDs, in table order:

1. `msg_011CfGcBDpThi52Nb9iKzmGD`
2. `msg_011CfGcD1tfcL2R8cicrpVKa`
3. `msg_011CfGcGGbY1HV2A7CVuwPSm`
4. `msg_011CfGcGGeGNugUSTLwpxe5Z`
5. `msg_011CfGcD1B1EHLbGjswrqzt1`
6. `msg_011CfGcD6DNxzk5uGnEksXCJ`

These measurements were observed in direct diagnostic API responses, not inferred
from documentation or mocked regression tests. Thinking content was neither printed
nor retained. The baseline runs took 18.55–19.61 seconds, close to the incident's
20.3-second failed requests; latency is corroborating evidence, not proof by itself.

## Historical incident and limits

The [Render application logs](https://dashboard.render.com/web/srv-daadmlhf2nfc73a0iin0)
show the initial answer at 07:51:14 EDT in 5.190 seconds, then empty responses
at 07:51:57 and 07:52:32 in 20.385 and 20.288 seconds. All returned HTTP 200
and reported `claude-sonnet-5`.

The incident's raw provider payload, stop reason, token usage, and exact snapshot
were not logged. The experiment therefore reproduces the mechanism, not a
bit-for-bit replay of those historical responses. The production code's default
budget was used; an effective `COPILOT_MAX_TOKENS` environment override was not
independently inspected. Production's model and provider URL were checked through
its status endpoint and the model appeared in its provider-backed model list.

Initial diagnostic attempts failed inside the sandbox credential proxy before
reaching the provider. A certificate-compatibility workaround was confined to
the standalone diagnostic client; no production TLS settings were changed.
These transport failures are unrelated to Wingwall's HTTP-200 empty replies.

## Corrective action recommendation

For this reasoning-heavy trading copilot, preserve reasoning but make the request
policy explicit and allocate room for both reasoning and the answer. An 8,192-token
cap completed this test with 2,176 actual output tokens; it is an experimentally
supported starting point, not a guarantee for every future prompt.

Explicitly disabling thinking also completed the test, but changes reasoning
behavior and should not be selected silently merely to make responses appear.
Compare answer quality before selecting that lower-latency policy.

Also:

- Treat `max_tokens` as an incomplete result even when some answer text exists.
- Retain safe response metadata for diagnosis.
- Keep retry/error handling as a secondary safeguard, not the root-cause fix.
- Remove the mitigation-only automatic retry as the primary proposed solution.
- Review the separate `callModelOnce` path before any rollout: it also omits
  thinking and defaults to a 1,200-token cap. Its automated gatekeeper behavior
  was not exercised or changed in these chat diagnostics.

PR #2 should be revised to implement the selected request policy before it is
merged. No deployment was performed as part of this investigation.
