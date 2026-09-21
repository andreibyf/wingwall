import assert from "node:assert/strict";
import { test } from "node:test";
import { requestCopilotReply, getCopilotChatPolicy } from "../server/copilot-response";

test("Sonnet 5 explicitly retains adaptive high-effort reasoning with sufficient budget", () => {
  assert.deepEqual(getCopilotChatPolicy("claude-sonnet-5"), {
    max_tokens: 8192, thinking: { type: "adaptive" }, output_config: { effort: "high" },
  });
});
for (const value of ["1400", "0", "-1", "NaN", "Infinity", "999999", "8192.5"]) {
  test(`unsafe budget ${value} uses 8192`, () => {
    assert.equal(getCopilotChatPolicy("claude-sonnet-5", value).max_tokens, 8192);
  });
}
test("honors valid larger budget and avoids unsupported adaptive fields on legacy models", () => {
  assert.equal(getCopilotChatPolicy("claude-sonnet-5", "16384").max_tokens, 16384);
  assert.deepEqual(getCopilotChatPolicy("claude-haiku-4-5"), { max_tokens: 8192 });
});
test("returns only complete text blocks without exposing thinking", async () => {
  const result = await requestCopilotReply(async () => ({
    content: [{ type: "thinking", text: "private" }, { type: "text", text: "First" }, { type: "text", text: "Second" }],
    stop_reason: "end_turn", model: "configured-model",
  }), 8192, "fallback");
  assert.deepEqual(result, { reply: "First\nSecond", model: "configured-model" });
});
for (const [name, value] of [
  ["empty", { content: [], stop_reason: "end_turn" }],
  ["missing", {}],
  ["null", null],
  ["whitespace", { content: [{ type: "text", text: "  " }], stop_reason: "end_turn" }],
  ["thinking only", { content: [{ type: "thinking", text: "private" }], stop_reason: "max_tokens" }],
  ["invalid text", { content: [{ type: "text", text: {} }, null], stop_reason: "end_turn" }],
  ["legacy placeholder", { content: [{ type: "text", text: "(empty response)" }], stop_reason: "end_turn" }],
  ["truncated advice", { content: [{ type: "text", text: "Enter this trade before..." }], stop_reason: "max_tokens" }],
  ["paused answer", { content: [{ type: "text", text: "Partial" }], stop_reason: "pause_turn" }],
  ["missing stop reason", { content: [{ type: "text", text: "Not proven complete" }] }],
]) {
  test(`rejects ${name} without retrying or presenting incomplete advice`, async () => {
    let calls = 0;
    await assert.rejects(requestCopilotReply(async () => { calls++; return value; }, 8192, "model"), { status: 502 });
    assert.equal(calls, 1);
  });
}
test("provider errors propagate without automatic retries", async () => {
  let calls = 0;
  await assert.rejects(requestCopilotReply(async () => {
    calls++; throw Object.assign(new Error("Rate limited"), { status: 429 });
  }, 8192, "model"), { status: 429 });
  assert.equal(calls, 1);
});
test("chat and gatekeeper use complete-response policy with sufficient thinking budget", async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://localhost/unused_copilot_test",
    COPILOT_API_KEY: "test-only-not-a-real-key",
    COPILOT_MODEL: "claude-sonnet-5", COPILOT_MAX_TOKENS: "1400",
    ANTHROPIC_BASE_URL: "http://localhost:1/v1",
  });
  const realFetch = globalThis.fetch;
  const requests: any[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "Complete answer." }], stop_reason: "end_turn",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const { runCopilotChat, callModelOnce } = await import("../server/copilot.ts");
    const result = await runCopilotChat([
      { role: "user", content: "Read campaign." },
      { role: "assistant", content: "(empty response)" },
      { role: "user", content: "yes" },
    ], { marker: "fresh-snapshot" });
    assert.equal(result.reply, "Complete answer.");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].max_tokens, 8192);
    assert.deepEqual(requests[0].thinking, { type: "adaptive" });
    assert.deepEqual(requests[0].output_config, { effort: "high" });
    assert.ok(requests[0].messages.every((m: any) => m.content !== "(empty response)"));
    assert.match(requests[0].messages.at(-1).content, /fresh-snapshot/);
    await callModelOnce("Gatekeeper", "Test only");
    assert.equal(requests[1].max_tokens, 8192);
    assert.deepEqual(requests[1].thinking, { type:"adaptive" });
    assert.deepEqual(requests[1].output_config, { effort:"high" });
    for(const response of [
      {content:[{type:"text",text:'{"approved":true,"rationale":"truncated"}'}],stop_reason:"max_tokens"},
      {content:[],stop_reason:"end_turn"},
    ]) {
      globalThis.fetch=async()=>new Response(JSON.stringify(response),{status:200});
      await assert.rejects(callModelOnce("Gatekeeper","test"),{status:502});
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const name of ["DATABASE_URL", "COPILOT_API_KEY", "COPILOT_MODEL", "COPILOT_MAX_TOKENS", "ANTHROPIC_BASE_URL"]) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
