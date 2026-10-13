/**
 * Model transport error taxonomy.
 *
 * Three disjoint outcome classes so experiments neither score infrastructure failures as
 * model behaviour nor hide failures the harness itself caused:
 *
 * - **Infra** (`ModelInfraError`, thrown, `infra: true`): the request never produced a model
 *   answer for reasons outside the harness — timeout, rate limit, 5xx (incl. transient
 *   gateway overload reported as 4xx), network, auth, model unavailable.
 * - **Request rejected** (`ModelRequestError`, thrown, `infra: false`): the endpoint refused
 *   the request the harness built (HTTP 400/413/422…: context overflow, invalid schema, …).
 *   Not a model failure, and NOT infra either — it must stay visible in results.
 * - **Protocol** (`{ type: "invalid", reason }` proposal, returned): the endpoint answered
 *   but the model's output cannot be turned into exactly one tool call or a stop.
 *   Reasons come from the closed set {@link MODEL_PROTOCOL_INVALID_REASONS}.
 *
 * Both thrown classes are structured: `kind`, `status`, `model`, `attempts`,
 * `total_attempts` are fields, and `toJSON()` / {@link modelTransportErrorJson} give the
 * serialized form to put in reports and events (never just the message string).
 */

export const MODEL_INFRA_ERROR_KINDS = [
  "timeout",
  "rate_limit",
  "server_error",
  "network",
  "auth",
  "model_unavailable",
] as const;

export type ModelInfraErrorKind = (typeof MODEL_INFRA_ERROR_KINDS)[number];

/** Non-infra transport failure kinds (closed set, D12). */
export const MODEL_REQUEST_ERROR_KINDS = ["request_rejected"] as const;

export type ModelRequestErrorKind = (typeof MODEL_REQUEST_ERROR_KINDS)[number];

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

/** Serialized form of a thrown transport error (reports, events, logs). */
export type ModelTransportErrorJson = {
  name: "ModelInfraError" | "ModelRequestError";
  infra: boolean;
  kind: ModelInfraErrorKind | ModelRequestErrorKind;
  /** HTTP status (or provider error code) when the endpoint answered. */
  status?: number;
  /** Model whose request failed. */
  model?: string;
  /** Requests sent to `model` in this propose() call before giving up. */
  attempts?: number;
  /** Requests sent to all models in this propose() call (fallback included). */
  total_attempts?: number;
  /** Bounded, secret-redacted provider text. */
  message: string;
};

type TransportErrorOpts = {
  status?: number;
  model?: string;
  attempts?: number;
  total_attempts?: number;
  cause?: unknown;
};

function toJsonFields(
  e: { kind: string; status?: number; model?: string; attempts?: number; total_attempts?: number; message: string },
  name: ModelTransportErrorJson["name"],
  infra: boolean,
): ModelTransportErrorJson {
  return {
    name,
    infra,
    kind: e.kind as ModelTransportErrorJson["kind"],
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.model !== undefined ? { model: e.model } : {}),
    ...(e.attempts !== undefined ? { attempts: e.attempts } : {}),
    ...(e.total_attempts !== undefined ? { total_attempts: e.total_attempts } : {}),
    message: boundProviderText(e.message),
  };
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
  /** Requests sent to `model` in this propose() call (set by the transport before throwing). */
  attempts?: number;
  /** Requests sent to all models in this propose() call (set by the transport). */
  total_attempts?: number;
  /** Legacy exit-code hint: 2 for rate limits. */
  readonly code?: number;

  constructor(kind: ModelInfraErrorKind, message: string, opts: TransportErrorOpts = {}) {
    const text =
      kind === "rate_limit" && !message.startsWith("RATE_LIMIT") ? `RATE_LIMIT: ${message}` : message;
    super(text, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ModelInfraError";
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.model !== undefined) this.model = opts.model;
    if (opts.attempts !== undefined) this.attempts = opts.attempts;
    if (opts.total_attempts !== undefined) this.total_attempts = opts.total_attempts;
    if (kind === "rate_limit") this.code = 2;
  }

  toJSON(): ModelTransportErrorJson {
    return toJsonFields(this, "ModelInfraError", true);
  }
}

/**
 * The endpoint rejected the request the harness built (not infra, not model behaviour):
 * context overflow, invalid tool schema, unsupported parameter, … Results must report it
 * separately instead of excluding it as an outage.
 */
export class ModelRequestError extends Error {
  readonly infra = false as const;
  readonly kind: ModelRequestErrorKind = "request_rejected";
  readonly status?: number;
  readonly model?: string;
  attempts?: number;
  total_attempts?: number;

  constructor(message: string, opts: TransportErrorOpts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ModelRequestError";
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.model !== undefined) this.model = opts.model;
    if (opts.attempts !== undefined) this.attempts = opts.attempts;
    if (opts.total_attempts !== undefined) this.total_attempts = opts.total_attempts;
  }

  toJSON(): ModelTransportErrorJson {
    return toJsonFields(this, "ModelRequestError", false);
  }
}

export type ModelTransportError = ModelInfraError | ModelRequestError;

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

export function isModelRequestError(e: unknown): e is ModelRequestError {
  if (e instanceof ModelRequestError) return true;
  if (!e || typeof e !== "object") return false;
  const o = e as { infra?: unknown; kind?: unknown };
  return (
    o.infra === false &&
    typeof o.kind === "string" &&
    (MODEL_REQUEST_ERROR_KINDS as readonly string[]).includes(o.kind)
  );
}

/** Structured form of a transport error (either class), or null for anything else. */
export function modelTransportErrorJson(e: unknown): ModelTransportErrorJson | null {
  if (e instanceof ModelInfraError || e instanceof ModelRequestError) return e.toJSON();
  if (isModelInfraError(e) || isModelRequestError(e)) {
    const o = e as unknown as ModelTransportErrorJson & { message?: unknown };
    return toJsonFields(
      { ...o, message: String(o.message ?? "") },
      o.infra ? "ModelInfraError" : "ModelRequestError",
      Boolean(o.infra),
    );
  }
  return null;
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
