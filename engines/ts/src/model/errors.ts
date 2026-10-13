/**
 * Model transport error taxonomy.
 *
 * Two disjoint failure classes so experiments can exclude infrastructure failures
 * from model scores:
 *
 * - **Infra** (`ModelInfraError`, thrown): the request never produced a model answer —
 *   timeout, rate limit, 5xx, network, auth, bad request, model unavailable.
 * - **Protocol** (`{ type: "invalid", reason }` proposal, returned): the endpoint answered
 *   but the model's output cannot be turned into exactly one tool call or a stop.
 *   Reasons come from the closed set {@link MODEL_PROTOCOL_INVALID_REASONS}.
 */

export const MODEL_INFRA_ERROR_KINDS = [
  "timeout",
  "rate_limit",
  "server_error",
  "network",
  "auth",
  "bad_request",
  "model_unavailable",
] as const;

export type ModelInfraErrorKind = (typeof MODEL_INFRA_ERROR_KINDS)[number];

/** Closed set of model-protocol failure reasons carried by `invalid` proposals (D12). */
export const MODEL_PROTOCOL_INVALID_REASONS = [
  /** 2xx response without a usable `choices[0].message`. */
  "empty_choices",
  /** Tool call names a transport function that was not offered. */
  "unknown_transport_tool",
  /** Tool call `arguments` is not valid JSON. */
  "invalid_tool_arguments_json",
  /** Tool call `arguments` parsed to null / array / scalar instead of an object. */
  "tool_arguments_not_object",
  /** Tool call `arguments` contain a non-integral or non-int53 number (D3: rejected at entry). */
  "tool_arguments_non_canonical",
  /** More than one tool call in a single turn (the runtime executes one per step). */
  "multiple_tool_calls",
  /** Tools were offered but the model answered without a tool call twice (conversational layer). */
  "empty_proposal",
] as const;

export type ModelProtocolInvalidReason = (typeof MODEL_PROTOCOL_INVALID_REASONS)[number];

export function isModelProtocolInvalidReason(r: unknown): r is ModelProtocolInvalidReason {
  return typeof r === "string" && (MODEL_PROTOCOL_INVALID_REASONS as readonly string[]).includes(r);
}

/**
 * Infrastructure failure: no model answer was obtained.
 *
 * Backward compatibility: rate limits keep the historical `RATE_LIMIT:` message prefix
 * and `code === 2` that existing hosts check.
 */
export class ModelInfraError extends Error {
  readonly infra = true as const;
  readonly kind: ModelInfraErrorKind;
  readonly status?: number;
  readonly model?: string;
  /** Legacy exit-code hint: 2 for rate limits. */
  readonly code?: number;

  constructor(
    kind: ModelInfraErrorKind,
    message: string,
    opts: { status?: number; model?: string; cause?: unknown } = {},
  ) {
    const text =
      kind === "rate_limit" && !message.startsWith("RATE_LIMIT") ? `RATE_LIMIT: ${message}` : message;
    super(text, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ModelInfraError";
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.model !== undefined) this.model = opts.model;
    if (kind === "rate_limit") this.code = 2;
  }
}

export function isModelInfraError(e: unknown): e is ModelInfraError {
  if (e instanceof ModelInfraError) return true;
  if (!e || typeof e !== "object") return false;
  const o = e as { infra?: unknown; kind?: unknown };
  return (
    o.infra === true &&
    typeof o.kind === "string" &&
    (MODEL_INFRA_ERROR_KINDS as readonly string[]).includes(o.kind)
  );
}

const KEY_LIKE_RE =
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:or-)?[A-Za-z0-9_-]{8,}\b/g;

/** Bound + redact provider text before it lands in an error message (D13). */
export function boundProviderText(text: string, maxCodePoints = 500): string {
  const redacted = String(text ?? "").replace(KEY_LIKE_RE, (_m, bearer?: string) =>
    bearer ? `${bearer}[REDACTED]` : "[REDACTED]",
  );
  const cps = Array.from(redacted);
  return cps.length > maxCodePoints ? `${cps.slice(0, maxCodePoints).join("")}…` : redacted;
}
