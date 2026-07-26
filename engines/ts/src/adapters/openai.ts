import type { ModelProposal } from "../types.js";

export interface LLMPort {
  propose(input: {
    messages: { role: string; content: string }[];
    tools: { id: string; description?: string }[];
  }): Promise<ModelProposal>;
}

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
  onModelUsed?: (model: string) => void;
};

type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export class OpenAICompatibleAdapter implements LLMPort {
  lastModelUsed = "";
  constructor(private cfg: OpenAICompatConfig) {}

  async propose(input: {
    messages: { role: string; content: string }[];
    tools: { id: string; description?: string }[];
  }): Promise<ModelProposal> {
    const tools = input.tools.map((t) => ({
      type: "function",
      function: {
        name: t.id.replace(/\./g, "_"),
        description: t.description ?? t.id,
        parameters: { type: "object", additionalProperties: true },
      },
    }));
    const idMap = new Map(tools.map((t, i) => [t.function.name, input.tools[i]!.id]));

    let lastErr: unknown;
    for (const model of this.cfg.models) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.cfg.apiKey}`,
              "Content-Type": "application/json",
              ...(this.cfg.headers ?? {}),
            },
            body: JSON.stringify({
              model,
              temperature: this.cfg.temperature ?? 0,
              max_tokens: this.cfg.maxTokens ?? 1024,
              messages: input.messages,
              tools: tools.length ? tools : undefined,
              tool_choice: tools.length ? "auto" : undefined,
            }),
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
            choices: { message: { content?: string; tool_calls?: ChatToolCall[] } }[];
          };
          this.lastModelUsed = model;
          this.cfg.onModelUsed?.(model);
          const msg = data.choices[0]?.message;
          const tc = msg?.tool_calls?.[0];
          if (tc) {
            const name = idMap.get(tc.function.name) ?? tc.function.name.replace(/_/g, ".");
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
            } catch {
              args = {};
            }
            return { type: "tool", name, args };
          }
          return { type: "stop", message: msg?.content ?? "" };
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

export function createOllamaAdapter(model = "llama3.2"): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    apiKey: process.env.OLLAMA_API_KEY ?? "ollama",
    models: [model],
  });
}

export function createOpenRouterAdapter(models?: string[]): OpenAICompatibleAdapter {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return new OpenAICompatibleAdapter({
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: key,
    models: models ?? [
      "openai/gpt-oss-20b:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "openrouter/free",
    ],
    temperature: 0,
    maxTokens: 1024,
    headers: {
      "HTTP-Referer": "https://github.com/fausth/fausth",
      "X-Title": "Faust Harness",
    },
  });
}
