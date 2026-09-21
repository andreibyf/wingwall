import assert from "node:assert/strict";
import { test } from "node:test";
import { requestCopilotReply } from "../server/copilot-response";

test("returns text only, preserving paragraph separation and model", async () => {
  const result = await requestCopilotReply(async () => ({
    content: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: "First" }, { type: "text", text: "Second" }],
    model: "configured-model",
  }), 1400, "fallback");
  assert.deepEqual(result, { reply: "First\nSecond", model: "configured-model" });
});

for (const [name, value] of [
  ["empty", { content: [] }],
  ["missing", {}],
  ["null", null],
  ["whitespace", { content: [{ type: "text", text: "  " }] }],
  ["thinking only", { content: [{ type: "thinking", text: "not an answer" }] }],
  ["invalid text", { content: [{ type: "text", text: {} }, null] }],
  ["legacy placeholder", { content: [{ type: "text", text: "(empty response)" }] }],
]) {
  test(`rejects ${name} with retryable 502 and no automatic retry`, async () => {
    let calls = 0;
    await assert.rejects(requestCopilotReply(async () => { calls++; return value; }, 1400, "model"), { status: 502 });
    assert.equal(calls, 1);
  });
}

test("retries token-exhausted empty reply once with a bounded larger budget", async () => {
  const budgets: number[] = [];
  const result = await requestCopilotReply(async (budget) => {
    budgets.push(budget);
    return budgets.length === 1
      ? { content: [{ type: "thinking" }], stop_reason: "max_tokens" }
      : { content: [{ type: "text", text: "Answer" }] };
  }, 1400, "model");
  assert.deepEqual(budgets, [1400, 4096]);
  assert.equal(result.reply, "Answer");
});

test("caps retry budget and rejects repeated exhaustion", async () => {
  const budgets: number[] = [];
  await assert.rejects(requestCopilotReply(async (budget) => {
    budgets.push(budget);
    return { content: [], stop_reason: "max_tokens" };
  }, 6000, "model"), { status: 502 });
  assert.deepEqual(budgets, [6000, 8192]);
});

test("does not reduce an already larger configured budget or retry indefinitely", async () => {
  let calls = 0;
  await assert.rejects(requestCopilotReply(async () => {
    calls++;
    return { content: [], stop_reason: "max_tokens" };
  }, 10000, "model"), { status: 502 });
  assert.equal(calls, 1);
});

test("propagates provider errors without an automatic retry", async () => {
  let calls = 0;
  await assert.rejects(requestCopilotReply(async () => {
    calls++;
    throw Object.assign(new Error("Rate limited"), { status: 429 });
  }, 1400, "model"), { status: 429 });
  assert.equal(calls, 1);
});

test("chat follow-up filters legacy placeholders and preserves fresh snapshot through retry", async () => {
  const previous = {
    database: process.env.DATABASE_URL, key: process.env.COPILOT_API_KEY,
    base: process.env.ANTHROPIC_BASE_URL,
  };
  process.env.DATABASE_URL = "postgresql://localhost/unused_copilot_test";
  process.env.COPILOT_API_KEY = "test-only-not-a-real-key";
  process.env.ANTHROPIC_BASE_URL = "http://localhost:1/v1";
  const realFetch = globalThis.fetch;
  const requests: any[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify(requests.length === 1
        ? { content: [], stop_reason: "max_tokens" }
        : { content: [{ type: "text", text: "Here is the current campaign." }] }),
      { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const { runCopilotChat } = await import("../server/copilot.ts");
    const result = await runCopilotChat([
      { role: "user", content: "Read the campaign." },
      { role: "assistant", content: "(empty response)" },
      { role: "user", content: "yes" },
    ], { marker: "fresh-snapshot" });
    assert.equal(result.reply, "Here is the current campaign.");
    assert.equal(requests.length, 2);
    assert.ok(requests[1].max_tokens > requests[0].max_tokens);
    assert.deepEqual(requests[0].messages, requests[1].messages);
    assert.ok(requests[0].messages.every((m: any) => m.content !== "(empty response)"));
    assert.match(requests[0].messages.at(-1).content, /fresh-snapshot/);
    assert.match(requests[0].messages.at(-1).content, /yes$/);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries({
      DATABASE_URL: previous.database, COPILOT_API_KEY: previous.key, ANTHROPIC_BASE_URL: previous.base,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
