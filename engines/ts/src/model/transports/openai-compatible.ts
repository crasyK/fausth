import type { ChatMessage, ModelPort, ModelProposeRequest, ModelProposal } from "../port.js";
import type { ProviderCapabilities } from "../capabilities.js";
import type { ProviderProfile } from "../profiles/index.js";
import {
  boundProviderText,
  ModelInfraError,
  ModelRequestError,
  type ModelInfraErrorKind,
  type ModelRequestErrorKind,
  type ModelTransportError,
} from "../errors.js";

/** Default per-request timeout (connect + full body). */
export const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;
const RAW_MAX_CODE_POINTS = 1000;
const INT53_MAX = 9007199254740991;

async function sleep(ms: number): Promise<void> {
  if (!(ms > 0)) return;
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
  /** Response-message fields to keep and re-attach to that assistant turn (same model only). */
  preserveResponseFields?: string[];
  onModelUsed?: (model: string) => void;
  /** Per-request timeout in ms (AbortSignal); default {@link DEFAULT_MODEL_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Attempts per model for retryable infra failures (429/5xx/network/timeout); default 4. */
  maxAttempts?: number;
  /** Base for exponential backoff between retries in ms; default 500. */
  retryBaseMs?: number;
  /** Called after every HTTP request with its per-call record (see {@link ModelCallRecord}). */
  onCall?: (record: ModelCallRecord) => void;
};

/**
 * One HTTP request made by the transport (host-side log, not the canonical event log).
 * `completion_id` is the provider response `id`; `repeat_of` marks a response whose id was
 * already returned by an earlier call of this adapter — e.g. a gateway cache hit.
 */
export type ModelCallRecord = {
  /** 1-based sequence number of the request within this adapter instance. */
  seq: number;
  model: string;
  /** 1-based request number for `model` within the propose() call. */
  attempt: number;
  /** HTTP status; null when no response arrived (network failure, timeout). */
  status: number | null;
  outcome: "ok" | "http_error" | "provider_error" | "malformed" | "timeout" | "network";
  completion_id?: string;
  created?: number;
  system_fingerprint?: string;
  /** `seq` of the earlier call that returned the same completion id. */
  repeat_of?: number;
  /** Error class of a failed request. */
  error_kind?: ModelInfraErrorKind | ModelRequestErrorKind;
  latency_ms: number;
};

/** Transient gateway errors some endpoints report as 4xx (KIT: "400 ServiceUnavailable" on overload). */
const TRANSIENT_4XX_RE =
  /service\s*unavailable|serviceunavailable|overloaded|temporarily unavailable|try again later|upstream (?:connect|request|error)|bad gateway|gateway time-?out/i;

type ChatToolCall = {
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: unknown };
};

type ChatResponseMessage = {
  content?: string | null;
  tool_calls?: ChatToolCall[];
  [k: string]: unknown;
};

type ChatResponse = {
  choices?: { message?: ChatResponseMessage; finish_reason?: string }[];
  error?: { code?: number | string; message?: string; [k: string]: unknown };
  [k: string]: unknown;
};

type Provenance = {
  model: string;
  provider_fields?: Record<string, unknown>;
  call_seq?: number;
  completion_id?: string;
  repeat_of_call?: number;
};

/** Provider response identity fields used to spot cached / duplicated responses. */
function completionMeta(data: ChatResponse): Pick<ModelCallRecord, "completion_id" | "created" | "system_fingerprint"> {
  const out: Pick<ModelCallRecord, "completion_id" | "created" | "system_fingerprint"> = {};
  if (typeof data?.id === "string" && data.id) out.completion_id = data.id;
  if (typeof data?.created === "number" && Number.isSafeInteger(data.created)) out.created = data.created;
  if (typeof data?.system_fingerprint === "string" && data.system_fingerprint) {
    out.system_fingerprint = data.system_fingerprint;
  }
  return out;
}

type ModelOutcome =
  | { ok: true; proposal: ModelProposal }
  | { ok: false; error: ModelTransportError; fallback: boolean };

type HttpFailure = { error: ModelTransportError; retry: boolean; fallback: boolean; waitMs?: number };

/** A fully-read HTTP reply (body read under the same timeout as the request). */
type HttpReply = { status: number; ok: boolean; headers: Headers; text: string };

/** Provider wording for exhausted daily/account quotas (retrying will not help). */
const QUOTA_RE = /daily|per[-\s]?day|quota/i;
const QUOTA_OR_LIMIT_RE = /daily|per[-\s]?day|quota|rate.?limit/i;

function capCodePoints(s: string, n = RAW_MAX_CODE_POINTS): string {
  const cps = Array.from(s);
  return cps.length > n ? `${cps.slice(0, n).join("")}…` : s;
}

function isAbortLike(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function retryAfterMs(res: HttpReply): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(h);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
  return undefined;
}

/** D3: model-supplied numbers must be int53 integers to enter the canonical event log. */
function hasNonCanonicalNumber(v: unknown): boolean {
  if (typeof v === "number") return !Number.isInteger(v) || Math.abs(v) > INT53_MAX;
  if (Array.isArray(v)) return v.some(hasNonCanonicalNumber);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).some(hasNonCanonicalNumber);
  return false;
}

/**
 * Serialize the transcript for one request to `model`. Host-side metadata (`model`,
 * `provider_fields`) never goes on the wire as-is; preserved provider fields are re-attached
 * to the assistant message they came from, and only when that turn was produced by the
 * same model (on fallback, another model's reasoning is dropped).
 */
export function wireMessages(messages: ChatMessage[], model: string): Record<string, unknown>[] {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role };
    if (m.content !== undefined) out.content = m.content;
    if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
    if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
    if (m.role === "assistant" && m.provider_fields && m.model === model) {
      for (const [k, v] of Object.entries(m.provider_fields)) {
        if (!(k in out) && k !== "model" && k !== "provider_fields") out[k] = v;
      }
    }
    return out;
  });
}

/**
 * Canonical OpenAI-compatible Chat Completions transport.
 * Provider quirks belong in profiles, not here.
 *
 * Infra failures throw {@link ModelInfraError}; model-protocol failures are returned as
 * `invalid` proposals (closed reason set in errors.ts). One tool call per step: requests
 * carry `parallel_tool_calls: false` and responses with more than one call are `invalid`.
 */
export class OpenAICompatibleAdapter implements ModelPort {
  lastModelUsed = "";
  /** Per-request log of this adapter instance (see {@link ModelCallRecord}). */
  readonly callLog: ModelCallRecord[] = [];
  /** Models whose endpoint rejected the `parallel_tool_calls` flag (do not resend). */
  private parallelFlagRejected = new Set<string>();
  private callSeq = 0;
  private seenCompletionIds = new Map<string, number>();
  /** Requests sent during the current propose() call (all models). */
  private proposeRequests = 0;

  constructor(private cfg: OpenAICompatConfig) {}

  private get timeoutMs(): number {
    const t = this.cfg.timeoutMs;
    return typeof t === "number" && t > 0 ? t : DEFAULT_MODEL_TIMEOUT_MS;
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

    this.proposeRequests = 0;
    let lastErr: ModelTransportError | undefined;
    for (const model of this.cfg.models) {
      const out = await this.proposeWithModel(model, input, tools, idMap);
      if (out.ok) return out.proposal;
      lastErr = out.error;
      lastErr.total_attempts = this.proposeRequests;
      if (!out.fallback) throw out.error;
    }
    throw lastErr ?? new ModelInfraError("model_unavailable", "no models configured", { total_attempts: 0 });
  }

  /** Remove and return the call records collected so far. */
  drainCallLog(): ModelCallRecord[] {
    return this.callLog.splice(0);
  }

  private record(rec: Omit<ModelCallRecord, "seq" | "repeat_of">): ModelCallRecord {
    const seq = ++this.callSeq;
    const out: ModelCallRecord = { seq, ...rec };
    if (rec.completion_id) {
      const prior = this.seenCompletionIds.get(rec.completion_id);
      if (prior !== undefined) out.repeat_of = prior;
      else this.seenCompletionIds.set(rec.completion_id, seq);
    }
    this.callLog.push(out);
    this.cfg.onCall?.(out);
    return out;
  }

  private async proposeWithModel(
    model: string,
    input: ModelProposeRequest,
    tools: Record<string, unknown>[],
    idMap: Map<string, string>,
  ): Promise<ModelOutcome> {
    const caps = this.cfg.capabilities;
    const maxAttempts = Math.max(1, this.cfg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const base = this.cfg.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const offerTools = tools.length > 0 && caps?.native_tools !== false;
    let toolChoice: "auto" | "required" = input.tool_choice === "required" ? "required" : "auto";
    let triedAutoAfterReject = false;
    let triedAutoAfterEmpty = false;
    let lastErr: ModelTransportError | undefined;
    let attempt = 0;
    /** Requests sent to this model (adjustment re-sends included). */
    let requests = 0;
    const fail = (error: ModelTransportError, fallback: boolean): ModelOutcome => {
      error.attempts = requests;
      return { ok: false, error, fallback };
    };

    const backoff = async (waitMs?: number) => {
      attempt += 1;
      if (attempt < maxAttempts) await sleep(waitMs ?? base * 2 ** (attempt - 1));
    };

    while (attempt < maxAttempts) {
      const sendParallelFlag =
        offerTools &&
        caps?.parallel_tool_calls_param !== false &&
        !this.parallelFlagRejected.has(model);
      const body: Record<string, unknown> = {
        model,
        temperature: this.cfg.temperature ?? 0,
        [caps?.max_tokens_field ?? "max_tokens"]: this.cfg.maxTokens ?? 1024,
        messages: wireMessages(input.messages, model),
      };
      if (offerTools) {
        body.tools = tools;
        if (caps?.tool_choice !== false) body.tool_choice = toolChoice;
        if (sendParallelFlag) body.parallel_tool_calls = false;
      }

      let res: HttpReply;
      requests += 1;
      this.proposeRequests += 1;
      const started = Date.now();
      try {
        res = await this.postRead(body);
      } catch (e) {
        lastErr = this.classifyThrown(e, model);
        this.record({
          model,
          attempt: requests,
          status: null,
          outcome: lastErr.kind === "timeout" ? "timeout" : "network",
          error_kind: lastErr.kind,
          latency_ms: Date.now() - started,
        });
        await backoff();
        continue;
      }
      const latency = Date.now() - started;

      if (!res.ok) {
        const text = res.text;
        const httpRecord = this.record({
          model,
          attempt: requests,
          status: res.status,
          outcome: "http_error",
          latency_ms: latency,
        });
        const requestFixable =
          res.status >= 400 &&
          res.status < 500 &&
          ![401, 402, 403, 404, 408, 429].includes(res.status);
        // Bounded request adjustments (not counted as retries).
        if (requestFixable && sendParallelFlag && /parallel_tool_calls/i.test(text)) {
          this.parallelFlagRejected.add(model);
          continue;
        }
        if (
          requestFixable &&
          body.tool_choice === "required" &&
          !triedAutoAfterReject &&
          /tool_choice|required|unsupported|invalid/i.test(text)
        ) {
          // Some gateways reject tool_choice:"required" — fall back to auto once.
          toolChoice = "auto";
          triedAutoAfterReject = true;
          continue;
        }
        const failure = this.classifyHttpFailure(res, text, model);
        httpRecord.error_kind = failure.error.kind;
        if (failure.retry) {
          lastErr = failure.error;
          await backoff(failure.waitMs);
          continue;
        }
        return fail(failure.error, failure.fallback);
      }

      let data: ChatResponse;
      try {
        data = JSON.parse(res.text) as ChatResponse;
      } catch (e) {
        lastErr = new ModelInfraError("server_error", `malformed (non-JSON) response body from ${model}`, {
          status: res.status,
          model,
          cause: e,
        });
        this.record({
          model,
          attempt: requests,
          status: res.status,
          outcome: "malformed",
          error_kind: lastErr.kind,
          latency_ms: latency,
        });
        await backoff();
        continue;
      }

      if (data && typeof data === "object" && data.error && !Array.isArray(data.choices)) {
        // Some gateways report provider failures in a 2xx body.
        const code = Number(data.error.code);
        const raw = String(data.error.message ?? JSON.stringify(data.error));
        const detail = boundProviderText(raw);
        const bodyRecord = this.record({
          model,
          attempt: requests,
          status: res.status,
          outcome: "provider_error",
          ...completionMeta(data),
          latency_ms: latency,
        });
        if (code === 429) {
          const err = new ModelInfraError("rate_limit", `${model}: ${detail}`, { status: 429, model });
          bodyRecord.error_kind = err.kind;
          if (QUOTA_RE.test(raw)) return fail(err, false);
          lastErr = err;
        } else if (code >= 400 && code < 500 && !TRANSIENT_4XX_RE.test(raw)) {
          // The provider refused the request the harness built — not an outage.
          const err = new ModelRequestError(`${model}: provider rejected the request (${code}): ${detail}`, {
            status: code,
            model,
          });
          bodyRecord.error_kind = err.kind;
          return fail(err, true);
        } else {
          lastErr = new ModelInfraError("server_error", `${model}: provider error in 2xx body: ${detail}`, {
            status: Number.isFinite(code) ? code : res.status,
            model,
          });
          bodyRecord.error_kind = lastErr.kind;
        }
        await backoff();
        continue;
      }

      const okRecord = this.record({
        model,
        attempt: requests,
        status: res.status,
        outcome: "ok",
        ...completionMeta(data),
        latency_ms: latency,
      });
      const callMeta = {
        call_seq: okRecord.seq,
        ...(okRecord.completion_id ? { completion_id: okRecord.completion_id } : {}),
        ...(okRecord.repeat_of !== undefined ? { repeat_of_call: okRecord.repeat_of } : {}),
      };

      this.lastModelUsed = model;
      this.cfg.onModelUsed?.(model);

      const msg = data?.choices?.[0]?.message;
      if (!msg || typeof msg !== "object") {
        return {
          ok: true,
          proposal: {
            type: "invalid",
            reason: "empty_choices",
            raw: capCodePoints(JSON.stringify(data)),
            model,
            ...callMeta,
          },
        };
      }
      const prov: Provenance = { model, ...callMeta };
      const preserved = this.capturePreserved(msg, data);
      if (preserved) prov.provider_fields = preserved;

      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (calls.length > 1) {
        // The runtime executes exactly one tool per step — never drop calls silently.
        const described = calls.map((c) => ({
          name: idMap.get(String(c?.function?.name ?? "")) ?? String(c?.function?.name ?? ""),
          arguments: c?.function?.arguments ?? null,
        }));
        return {
          ok: true,
          proposal: {
            type: "invalid",
            reason: "multiple_tool_calls",
            raw: capCodePoints(JSON.stringify(described)),
            ...prov,
          },
        };
      }
      if (calls.length === 1) {
        return { ok: true, proposal: this.toToolProposal(calls[0]!, idMap, prov) };
      }

      // Some gateways accept tool_choice:"required" but return no tool_calls. Retry once with auto.
      if (body.tool_choice === "required" && !triedAutoAfterEmpty) {
        toolChoice = "auto";
        triedAutoAfterEmpty = true;
        continue;
      }
      return {
        ok: true,
        proposal: { type: "stop", message: typeof msg.content === "string" ? msg.content : "", ...prov },
      };
    }
    return fail(
      lastErr ?? new ModelInfraError("server_error", `no usable response from ${model}`, { model }),
      true,
    );
  }

  /**
   * POST and read the full body under one timeout. A ref'd timer (cleared in finally)
   * guarantees the abort fires even if the fetch implementation holds no event-loop ref.
   */
  private async postRead(body: Record<string, unknown>): Promise<HttpReply> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException(`timed out after ${this.timeoutMs}ms`, "TimeoutError")),
      this.timeoutMs,
    );
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
          ...(this.cfg.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, headers: res.headers, text };
    } finally {
      clearTimeout(timer);
    }
  }

  private classifyThrown(e: unknown, model: string): ModelInfraError {
    if (e instanceof ModelInfraError) return e;
    if (isAbortLike(e)) {
      return new ModelInfraError("timeout", `model request timed out after ${this.timeoutMs}ms (${model})`, {
        model,
        cause: e,
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    const cause = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
    return new ModelInfraError(
      "network",
      `model request failed (${model}): ${boundProviderText(msg)}${typeof cause === "string" ? ` [${cause}]` : ""}`,
      { model, cause: e },
    );
  }

  private classifyHttpFailure(res: HttpReply, text: string, model: string): HttpFailure {
    // Classification reads the provider text; only the bounded, redacted form is kept.
    const status = res.status;
    const detail = `${model} HTTP ${status}: ${boundProviderText(text)}`;
    if (status === 429) {
      const error = new ModelInfraError("rate_limit", detail, { status, model });
      if (QUOTA_RE.test(text)) return { error, retry: false, fallback: false };
      return { error, retry: true, fallback: true, waitMs: retryAfterMs(res) };
    }
    if (status === 401 || status === 402 || status === 403) {
      if (QUOTA_OR_LIMIT_RE.test(text)) {
        return { error: new ModelInfraError("rate_limit", detail, { status, model }), retry: false, fallback: false };
      }
      return { error: new ModelInfraError("auth", detail, { status, model }), retry: false, fallback: false };
    }
    if (status === 404) {
      return {
        error: new ModelInfraError("model_unavailable", `model unavailable: ${detail}`, { status, model }),
        retry: false,
        fallback: true,
      };
    }
    if (status === 408) {
      return { error: new ModelInfraError("timeout", detail, { status, model }), retry: true, fallback: true };
    }
    if (status >= 500) {
      return { error: new ModelInfraError("server_error", detail, { status, model }), retry: true, fallback: true };
    }
    if (TRANSIENT_4XX_RE.test(text)) {
      // Known transient gateway errors reported as 4xx (KIT: "400 ServiceUnavailable" when
      // overloaded) are outages: retry, then fall back.
      return { error: new ModelInfraError("server_error", detail, { status, model }), retry: true, fallback: true };
    }
    if (QUOTA_OR_LIMIT_RE.test(text)) {
      // Legacy: some gateways report quota exhaustion as a non-429 4xx.
      return { error: new ModelInfraError("rate_limit", detail, { status, model }), retry: false, fallback: false };
    }
    // 400/413/422…: the endpoint rejected the request the harness built (context overflow,
    // invalid schema, …). Not infra — results must show it. Another model may still accept it.
    return {
      error: new ModelRequestError(`request rejected: ${detail}`, { status, model }),
      retry: false,
      fallback: true,
    };
  }

  private capturePreserved(
    msg: ChatResponseMessage,
    data: ChatResponse,
  ): Record<string, unknown> | undefined {
    let out: Record<string, unknown> | undefined;
    for (const field of this.cfg.preserveResponseFields ?? []) {
      const v = msg[field] !== undefined && msg[field] !== null ? msg[field] : data[field];
      if (v === undefined || v === null) continue;
      (out ??= {})[field] = v;
    }
    return out;
  }

  private toToolProposal(tc: ChatToolCall, idMap: Map<string, string>, prov: Provenance): ModelProposal {
    const transportName = tc.function?.name;
    const name = typeof transportName === "string" ? idMap.get(transportName) : undefined;
    if (!name) {
      return {
        type: "invalid",
        reason: "unknown_transport_tool",
        raw: capCodePoints(String(transportName ?? "")),
        ...prov,
      };
    }
    const rawArgs = tc.function?.arguments;
    let parsed: unknown;
    if (rawArgs === undefined || rawArgs === null || (typeof rawArgs === "string" && rawArgs.trim() === "")) {
      parsed = {};
    } else if (typeof rawArgs === "string") {
      try {
        parsed = JSON.parse(rawArgs);
      } catch {
        return { type: "invalid", reason: "invalid_tool_arguments_json", raw: capCodePoints(rawArgs), ...prov };
      }
    } else {
      parsed = rawArgs;
    }
    const rawText = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { type: "invalid", reason: "tool_arguments_not_object", raw: capCodePoints(rawText), ...prov };
    }
    if (hasNonCanonicalNumber(parsed)) {
      return { type: "invalid", reason: "tool_arguments_non_canonical", raw: capCodePoints(rawText), ...prov };
    }
    return {
      type: "tool",
      name,
      args: parsed as Record<string, unknown>,
      ...(typeof tc.id === "string" && tc.id ? { tool_call_id: tc.id } : {}),
      transport_name: transportName,
      ...prov,
    };
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
    timeoutMs?: number;
    /** Deployment override for profile.compatibility.preserve_response_fields. */
    preserveResponseFields?: string[];
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
    preserveResponseFields:
      opts.preserveResponseFields ?? profile.compatibility?.preserve_response_fields,
    timeoutMs: opts.timeoutMs,
  });
}
