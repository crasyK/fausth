/** Declared / probed provider capabilities. */
export type ProviderCapabilities = {
  chat_completions: boolean;
  native_tools: boolean | "unknown";
  parallel_tools: boolean | "unknown";
  structured_output: boolean | "unknown";
  streaming: boolean | "unknown";
  /** How to handle provider reasoning fields across turns. */
  reasoning_details: "preserve" | "drop" | "unknown";
  /** Token limit field name preferred by this profile. */
  max_tokens_field: "max_tokens" | "max_completion_tokens";
  /** Whether tool_choice is supported. */
  tool_choice: boolean | "unknown";
  tested_model?: string;
};

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  chat_completions: true,
  native_tools: "unknown",
  parallel_tools: "unknown",
  structured_output: "unknown",
  streaming: "unknown",
  reasoning_details: "unknown",
  max_tokens_field: "max_tokens",
  tool_choice: "unknown",
};
