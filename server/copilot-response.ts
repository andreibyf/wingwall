type ProviderReply = {
  content?: Array<{ type?: string; text?: unknown; name?: string; input?: unknown }>;
  stop_reason?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function getCopilotChatPolicy(model: string, configuredBudget?: string, effort: "high" | "medium" = "high") {
  const value = Number(configuredBudget);
  const minimum = effort === "medium" ? 16384 : 8192;
  // The old 1400-token ceiling can be exhausted entirely by hidden thinking.
  // Honor larger valid limits, but never retain that unsafe legacy chat ceiling.
  const max_tokens = Number.isInteger(value) && value >= minimum && value <= 128000 ? value : minimum;
  // Sonnet 5 is production's model. Do not send unsupported adaptive settings
  // to the older Haiku fallback or unknown Messages-compatible providers.
  return /^claude-sonnet-5(?:-|$)/.test(model)
    ? { max_tokens, thinking: { type: "adaptive" as const }, output_config: { effort } }
    : { max_tokens };
}

/** One request only. Never present hidden reasoning or incomplete advice as an answer. */
export async function requestCopilotReply(
  request: (maxTokens: number) => Promise<unknown>,
  budget: number,
  fallbackModel: string,
  saveDraft?: (input:unknown,model:string)=>Promise<unknown>,
): Promise<{ reply: string; model: string; draft?:unknown }> {
  const data = await request(budget) as ProviderReply | null;
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const reply = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string).join("\n").trim();
  const complete = data?.stop_reason === "end_turn";
  const tools=blocks.filter(b=>b?.type==="tool_use");
  if(data?.stop_reason==="tool_use" && saveDraft && tools.length===1 && tools[0].name==="save_recommendation_draft") {
    const model=typeof data.model==="string"?data.model:fallbackModel;
    const draft=await saveDraft(tools[0].input,model);
    // Do not echo unverified claims about writes from accompanying model prose.
    return {reply:"Draft saved in Strategy → Recommendation drafts for review and editing. No position created, checklist approved, or automation armed. Verify missing evidence before use.",model,draft};
  }
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
  if (complete && tools.length===0 && reply && reply !== "(empty response)") {
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
