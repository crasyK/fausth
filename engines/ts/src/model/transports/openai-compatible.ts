import type { ModelPort, ModelProposeRequest, ModelProposal } from "../port.js";
import type { ProviderCapabilities } from "../capabilities.js";
import type { ProviderProfile } from "../profiles/index.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export type OpenAICompatConfig = {
  baseUrl: string;
  apiKey: string;
  models: string[];
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  capabilities?: ProviderCapabilities;
  preserveResponseFields?: string[];
  onModelUsed?: (model: string) => void;
  /** Session bag for preserve_response_fields across turns. */
  sessionExtras?: Record<string, unknown>;
};

type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/**
 * Canonical OpenAI-compatible Chat Completions transport.
 * Provider quirks belong in profiles, not here.
 */
export class OpenAICompatibleAdapter implements ModelPort {
  lastModelUsed = "";
  private sessionExtras: Record<string, unknown>;

  constructor(private cfg: OpenAICompatConfig) {
    this.sessionExtras = cfg.sessionExtras ?? {};
  }

  async propose(input: ModelProposeRequest): Promise<ModelProposal> {
    // Opaque transport names — never reverse by underscore heuristics
    const idMap = new Map<string, string>();
    const tools = input.tools.map((t, i) => {
      const transportName = `faust_tool_${String(i + 1).padStart(4, "0")}`;
      idMap.set(transportName, t.id);
      const parameters =
        t.input && Object.keys(t.input).length > 0
          ? t.input
          : { type: "object", additionalProperties: true };
      return {
        type: "function" as const,
        function: {
          name: transportName,
          description: t.description ?? t.id,
          parameters,
        },
      };
    });

    const caps = this.cfg.capabilities;
    const maxField = caps?.max_tokens_field ?? "max_tokens";
    const useToolChoice = caps?.tool_choice !== false;

    let lastErr: unknown;
    for (const model of this.cfg.models) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const body: Record<string, unknown> = {
            model,
            temperature: this.cfg.temperature ?? 0,
            [maxField]: this.cfg.maxTokens ?? 1024,
            messages: input.messages,
          };
          if (tools.length && caps?.native_tools !== false) {
            body.tools = tools;
            if (useToolChoice) body.tool_choice = "auto";
          }
          // Re-attach preserved provider fields (e.g. reasoning_details)
          for (const [k, v] of Object.entries(this.sessionExtras)) {
            body[k] = v;
          }

          const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.cfg.apiKey}`,
              "Content-Type": "application/json",
              ...(this.cfg.headers ?? {}),
            },
            body: JSON.stringify(body),
          });
          if (res.status === 429) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          if (res.status === 404) {
            lastErr = new Error(`model unavailable: ${model}`);
            break;
          }
          if (!res.ok) {
            const text = await res.text();
            if (/daily|rate.?limit|quota/i.test(text)) {
              const err = new Error(`RATE_LIMIT: ${text}`) as Error & { code?: number };
              err.code = 2;
              throw err;
            }
            throw new Error(`OpenAI-compatible error ${res.status}: ${text}`);
          }
          const data = (await res.json()) as {
            choices: {
              message: {
                content?: string;
                tool_calls?: ChatToolCall[];
                [k: string]: unknown;
              };
            }[];
            [k: string]: unknown;
          };
          this.lastModelUsed = model;
          this.cfg.onModelUsed?.(model);

          const msg = data.choices[0]?.message;
          if (!msg) {
            return { type: "invalid", reason: "empty_choices", raw: JSON.stringify(data) };
          }

          // Preserve configured response fields for next turn
          for (const field of this.cfg.preserveResponseFields ?? []) {
            const fromMsg = msg[field];
            const fromRoot = data[field];
            if (fromMsg !== undefined) this.sessionExtras[field] = fromMsg;
            else if (fromRoot !== undefined) this.sessionExtras[field] = fromRoot;
          }

          const tc = msg.tool_calls?.[0];
          if (tc) {
            const name = idMap.get(tc.function.name);
            if (!name) {
              return {
                type: "invalid",
                reason: "unknown_transport_tool",
                raw: tc.function.name,
              };
            }
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
            } catch {
              return {
                type: "invalid",
                reason: "invalid_tool_arguments_json",
                raw: tc.function.arguments,
              };
            }
            return {
              type: "tool",
              name,
              args,
              tool_call_id: tc.id,
              transport_name: tc.function.name,
            };
          }
          return { type: "stop", message: msg.content ?? "" };
        } catch (e) {
          lastErr = e;
          if (e instanceof Error && e.message.startsWith("RATE_LIMIT")) throw e;
          if (attempt < 3) await sleep(500 * 2 ** attempt);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

export function adapterFromProfile(
  profile: ProviderProfile,
  opts: {
    baseUrl?: string;
    apiKey: string;
    models: string[];
    temperature?: number;
    maxTokens?: number;
    headers?: Record<string, string>;
  },
): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    baseUrl: opts.baseUrl ?? profile.defaultBaseUrl ?? "https://api.openai.com/v1",
    apiKey: opts.apiKey,
    models: opts.models,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    headers: { ...(profile.defaultHeaders ?? {}), ...(opts.headers ?? {}) },
    capabilities: profile.capabilities,
    preserveResponseFields: profile.compatibility?.preserve_response_fields,
  });
}
