import type { Deployment, DeploymentModelEntry } from "../types.js";
import type { ModelPort } from "./port.js";
import { resolveProfile, type ProviderProfileId } from "./profiles/index.js";
import { adapterFromProfile, OpenAICompatibleAdapter } from "./transports/openai-compatible.js";

export type ResolvedModelBinding = {
  adapter: ModelPort & { lastModelUsed: string };
  profileId: ProviderProfileId | "generic";
  models: string[];
  baseUrl: string;
  apiKeyEnv: string;
};

function legacyProfile(transport: string): ProviderProfileId | undefined {
  if (transport === "openrouter") return "openrouter";
  if (transport === "ollama") return "ollama";
  if (transport === "openai-compatible") return undefined;
  return undefined;
}

/** Resolve API key from env only — never from deployment YAML literals. */
export function resolveApiKey(envName: string, fallback?: string): string {
  const v = process.env[envName] ?? fallback;
  if (!v) {
    throw new Error(`API key env ${envName} is not set (deployment must use api_key_env)`);
  }
  return v;
}

/**
 * Filter model IDs by deployment data_policy vs admin-authored model_catalog.
 * Remote catalogs must never weaken this — only local metadata applies.
 */
export function filterModelsByDataPolicy(models: string[], deployment: Deployment): string[] {
  const requireResidency = deployment.data_policy?.require?.residency;
  if (!requireResidency || !deployment.model_catalog?.length) return models;
  const allowed = new Set(
    deployment.model_catalog
      .filter((e: DeploymentModelEntry) => {
        const loc = e.policy?.residency ?? e.policy?.processing_location;
        return loc === requireResidency;
      })
      .map((e) => e.id),
  );
  const filtered = models.filter((m) => allowed.has(m));
  if (filtered.length === 0) {
    throw new Error(`No models satisfy data_policy.require.residency=${requireResidency}`);
  }
  return filtered;
}

/**
 * Build a ModelPort from a deployment.yml binding.
 * Supports both modern `transport: openai-compatible` + `profile`
 * and legacy `transport: openrouter|ollama`.
 */
export function createAdapterFromDeployment(deployment: Deployment): ResolvedModelBinding {
  const m = deployment.model;
  const transport = m.transport ?? "openai-compatible";

  if (transport === "recorded") {
    throw new Error("recorded transport is for fixtures only; use openai-compatible for live/run");
  }

  const profileId =
    (m.profile as ProviderProfileId | undefined) ?? legacyProfile(transport) ?? "generic";
  const profile = resolveProfile(profileId);

  if (m.api_key) {
    throw new Error("deployment.model.api_key is forbidden — use api_key_env");
  }

  const apiKeyEnv = m.api_key_env ?? profile.defaultApiKeyEnv;
  const apiKey = resolveApiKey(apiKeyEnv, profile.defaultApiKey);

  const baseUrl =
    m.base_url ?? m.endpoint ?? profile.defaultBaseUrl ?? "https://api.openai.com/v1";

  let models =
    m.models ?? (m.model ? [m.model] : undefined) ?? profile.defaultModels ?? [];
  if (models.length === 0) {
    throw new Error("deployment.model.models (or model) is required");
  }

  models = filterModelsByDataPolicy(models, deployment);

  const banned = profile.compatibility?.prohibited_model_aliases ?? [];
  for (const id of models) {
    if (banned.includes(id)) {
      throw new Error(
        `Model alias '${id}' is prohibited for profile ${profile.id} (gateway system prompt)`,
      );
    }
  }

  const adapter = adapterFromProfile(profile, {
    baseUrl,
    apiKey,
    models,
    temperature: m.temperature,
    maxTokens: m.max_tokens,
  });

  return {
    adapter,
    profileId: profile.id,
    models,
    baseUrl,
    apiKeyEnv,
  };
}

/** Convenience constructors (profiles under openai-compatible). */
export function createOpenRouterAdapter(models?: string[]): OpenAICompatibleAdapter {
  const profile = resolveProfile("openrouter");
  const fromEnv = process.env.OPENROUTER_MODELS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return adapterFromProfile(profile, {
    apiKey: resolveApiKey(profile.defaultApiKeyEnv),
    models: models ?? fromEnv ?? profile.defaultModels ?? [],
  });
}

export function createOllamaAdapter(model = "llama3.2"): OpenAICompatibleAdapter {
  const profile = resolveProfile("ollama");
  return adapterFromProfile(profile, {
    apiKey: resolveApiKey(profile.defaultApiKeyEnv, profile.defaultApiKey),
    models: [model],
  });
}

export function createKitAdapter(models: string[]): OpenAICompatibleAdapter {
  const profile = resolveProfile("kit-scc");
  return adapterFromProfile(profile, {
    apiKey: resolveApiKey(profile.defaultApiKeyEnv),
    models,
  });
}
