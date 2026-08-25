const VERIFIED_MODELS = [
  {
    match: /^gpt-5\.5$/,
    context_lengths: [1050000],
    max_input_tokens: 1050000,
    reasoning_efforts: ["low", "medium", "high", "xhigh"],
    reasoning: true,
    reasoning_disabled: true,
    vision: true,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    default_reasoning_effort: "medium"
  },
  {
    match: /^gpt-5\.6-(?:sol|terra)$/,
    context_lengths: [1050000],
    max_input_tokens: 1050000,
    reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
    reasoning: true,
    reasoning_required: true,
    vision: true,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    default_reasoning_effort: "medium"
  },
  {
    match: /^grok-4\.6$/,
    context_lengths: [500000],
    max_input_tokens: 500000,
    reasoning_efforts: ["low", "medium", "high", "xhigh"],
    reasoning: true,
    reasoning_required: true,
    vision: true,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    default_reasoning_effort: "medium"
  }
];

export function verifiedUpstreamMetadata(modelId) {
  const match = VERIFIED_MODELS.find((entry) => entry.match.test(String(modelId ?? "")));
  if (!match) return undefined;
  const { match: _match, ...metadata } = match;
  return {
    ...metadata,
    context_lengths: [...metadata.context_lengths],
    reasoning_efforts: [...metadata.reasoning_efforts],
    input_modalities: [...metadata.input_modalities],
    output_modalities: [...metadata.output_modalities]
  };
}
