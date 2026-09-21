type ProviderReply = {
  content?: Array<{ type?: string; text?: unknown }>;
  stop_reason?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function getCopilotChatPolicy(model: string, configuredBudget?: string) {
  const value = Number(configuredBudget);
  // The old 1400-token ceiling can be exhausted entirely by hidden thinking.
  // Honor larger valid limits, but never retain that unsafe legacy chat ceiling.
  const max_tokens = Number.isInteger(value) && value >= 8192 && value <= 128000 ? value : 8192;
  // Sonnet 5 is production's model. Do not send unsupported adaptive settings
  // to the older Haiku fallback or unknown Messages-compatible providers.
  return /^claude-sonnet-5(?:-|$)/.test(model)
    ? { max_tokens, thinking: { type: "adaptive" as const }, output_config: { effort: "high" as const } }
    : { max_tokens };
}

/** One request only. Never present hidden reasoning or incomplete advice as an answer. */
export async function requestCopilotReply(
  request: (maxTokens: number) => Promise<unknown>,
  budget: number,
  fallbackModel: string,
): Promise<{ reply: string; model: string }> {
  const data = await request(budget) as ProviderReply | null;
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const reply = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string).join("\n").trim();
  const complete = data?.stop_reason === "end_turn";
  // Safe diagnostic metadata only: never prompt, answer, hidden thinking or credentials.
  console.info("Copilot response metadata", {
    model: data?.model ?? fallbackModel,
    stopReason: data?.stop_reason,
    blockTypes: blocks.map((block) => block?.type),
    inputTokens: data?.usage?.input_tokens,
    outputTokens: data?.usage?.output_tokens,
    budget,
    hasAnswer: Boolean(reply),
    complete,
  });
  if (complete && reply && reply !== "(empty response)") {
    return { reply, model: typeof data?.model === "string" ? data.model : fallbackModel };
  }
  throw Object.assign(
    new Error(data?.stop_reason === "max_tokens"
      ? "The model reached its output limit. The incomplete answer was withheld. Please ask a narrower question or retry."
      : reply && !complete
        ? "The model did not finish its answer. Please retry your last message."
        : "The model returned no answer text. Please retry your last message."),
    { status: 502 },
  );
}
