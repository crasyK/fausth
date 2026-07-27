import type { ProviderCapabilities } from "../capabilities.js";
import { DEFAULT_CAPABILITIES } from "../capabilities.js";

export type ProviderProfileId = "generic" | "kit-scc" | "openrouter" | "ollama";

export type ProviderProfile = {
  id: ProviderProfileId;
  /** Default OpenAI-compatible base URL (no trailing slash required). */
  defaultBaseUrl?: string;
  /** Env var name that holds the API key. */
  defaultApiKeyEnv: string;
  /** Fallback when env is unset (e.g. ollama dummy). */
  defaultApiKey?: string;
  /** Extra HTTP headers. */
  defaultHeaders?: Record<string, string>;
  /** Default model list when deployment omits models. */
  defaultModels?: string[];
  capabilities: ProviderCapabilities;
  compatibility?: {
    preserve_response_fields?: string[];
    /** Known aliases that inject gateway system prompts — unsuitable for Faust. */
    prohibited_model_aliases?: string[];
    gateway_system_prompt?: "prohibited" | "unknown";
  };
};

export const PROFILES: Record<ProviderProfileId, ProviderProfile> = {
  generic: {
    id: "generic",
    defaultApiKeyEnv: "OPENAI_API_KEY",
    capabilities: { ...DEFAULT_CAPABILITIES },
  },
  "kit-scc": {
    id: "kit-scc",
    defaultBaseUrl: "https://ki-toolbox.scc.kit.edu/api/v1",
    defaultApiKeyEnv: "KIT_AI_API_KEY",
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      native_tools: "unknown",
      tool_choice: "unknown",
      reasoning_details: "preserve",
    },
    compatibility: {
      preserve_response_fields: ["reasoning_details"],
      prohibited_model_aliases: ["standard-external", "standard-local"],
      gateway_system_prompt: "prohibited",
    },
  },
  openrouter: {
    id: "openrouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultApiKeyEnv: "OPENROUTER_API_KEY",
    defaultModels: [
      "cohere/north-mini-code:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "google/gemma-4-26b-a4b-it:free",
    ],
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/crasyK/fausth",
      "X-Title": "Faust Harness",
    },
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      native_tools: true,
      tool_choice: true,
    },
  },
  ollama: {
    id: "ollama",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    defaultApiKeyEnv: "OLLAMA_API_KEY",
    defaultApiKey: "ollama",
    defaultModels: ["llama3.2"],
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      native_tools: "unknown",
      tool_choice: "unknown",
    },
  },
};

export function resolveProfile(id?: string): ProviderProfile {
  if (!id) return PROFILES.generic;
  const key = id as ProviderProfileId;
  if (PROFILES[key]) return PROFILES[key];
  throw new Error(`Unknown provider profile: ${id}`);
}
