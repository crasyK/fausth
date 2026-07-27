import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Deployment } from "../types.js";
import type { ProviderCapabilities } from "./capabilities.js";
import { createAdapterFromDeployment } from "./resolve.js";
import { resolveProfile } from "./profiles/index.js";

export type ProbeReport = ProviderCapabilities & {
  profile: string;
  base_url: string;
  auth: boolean;
  models_requested: string[];
  error?: string;
  redacted: true;
};

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Probe an OpenAI-compatible deployment without sending sensitive data.
 * Results are capability declarations — they do not weaken local policy.
 */
export async function probeProvider(deployment: Deployment): Promise<ProbeReport> {
  const profile = resolveProfile(
    deployment.model.profile ??
      (deployment.model.transport === "openrouter"
        ? "openrouter"
        : deployment.model.transport === "ollama"
          ? "ollama"
          : "generic"),
  );

  const base: ProbeReport = {
    ...profile.capabilities,
    profile: profile.id,
    base_url: deployment.model.base_url ?? deployment.model.endpoint ?? profile.defaultBaseUrl ?? "",
    auth: false,
    models_requested: deployment.model.models ?? (deployment.model.model ? [deployment.model.model] : []),
    redacted: true,
  };

  try {
    const { adapter, models, baseUrl } = createAdapterFromDeployment(deployment);
    base.base_url = baseUrl;
    base.models_requested = models;
    base.auth = true;

    // 1) Basic chat completion (no tools, innocuous prompt)
    const chat = await adapter.propose({
      messages: [
        { role: "system", content: "Reply with the single word: pong" },
        { role: "user", content: "ping" },
      ],
      tools: [],
    });
    base.chat_completions = chat.type === "stop" || chat.type === "tool";
    base.tested_model = adapter.lastModelUsed;

    await sleep(200);

    // 2) Native tool calling with opaque name + real schema
    try {
      const toolProbe = await adapter.propose({
        messages: [
          {
            role: "system",
            content: "You must call the provided tool. Do not answer in plain text.",
          },
          { role: "user", content: "Set value to 1 using the tool." },
        ],
        tools: [
          {
            id: "probe.echo.set",
            description: "Echo an integer value",
            input: {
              type: "object",
              required: ["value"],
              additionalProperties: false,
              properties: { value: { type: "integer" } },
            },
          },
        ],
      });
      if (toolProbe.type === "tool" && toolProbe.name === "probe.echo.set") {
        base.native_tools = true;
        base.tool_choice = true;
        const v = toolProbe.args.value;
        base.structured_output = typeof v === "number" && Number.isInteger(v);
      } else if (toolProbe.type === "tool") {
        base.native_tools = false;
      } else {
        base.native_tools = false;
      }
    } catch {
      base.native_tools = false;
    }

    return base;
  } catch (e) {
    return {
      ...base,
      auth: false,
      chat_completions: false,
      error: e instanceof Error ? e.message.replace(/sk-[a-zA-Z0-9_-]+/g, "[REDACTED]") : String(e),
    };
  }
}

export function writeProbeReport(path: string, report: ProbeReport): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
}
