type ProviderReply = {
  content?: Array<{ type?: string; text?: unknown }>;
  stop_reason?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/** Never expose thinking blocks, provider payloads, or empty placeholders as answers. */
export async function requestCopilotReply(
  request: (maxTokens: number) => Promise<unknown>,
  initialBudget: number,
  fallbackModel: string,
): Promise<{ reply: string; model: string }> {
  let budget = initialBudget;
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await request(budget) as ProviderReply | null;
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const reply = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string).join("\n").trim();
    if (reply && reply !== "(empty response)") {
      return { reply, model: typeof data?.model === "string" ? data.model : fallbackModel };
    }
    // Metadata only: no prompts, account data, text, thinking, or credentials.
    console.warn("Copilot returned no answer text", {
      stopReason: data?.stop_reason,
      blockTypes: blocks.map((block) => block?.type),
      outputTokens: data?.usage?.output_tokens,
      budget,
      attempt: attempt + 1,
    });
    const nextBudget = Math.min(8192, Math.max(4096, budget * 2));
    if (attempt === 0 && data?.stop_reason === "max_tokens" && nextBudget > budget) {
      budget = nextBudget;
      continue;
    }
    throw Object.assign(
      new Error(data?.stop_reason === "max_tokens"
        ? "The model reached its output limit before producing an answer. Please retry or ask a narrower question."
        : "The model returned no answer text. Please retry your last message."),
      { status: 502 },
    );
  }
  throw Object.assign(new Error("The model returned no answer text. Please retry."), { status: 502 });
}
