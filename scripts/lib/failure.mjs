/**
 * Failure classification for case-study attempts (SCR-13).
 *
 * An attempt is an *infrastructure* failure only when the failure is known to
 * come from the transport / provider / host plumbing — never because an error
 * message happens to contain words like "missing", "adapter" or "workspace".
 * Infrastructure failures are excluded from model-performance denominators but
 * always reported per arm (and in an infra-as-failure sensitivity line).
 *
 * Order of evidence:
 *   1. structured error objects  ({ kind, infra, code } from the transport/CLI)
 *   2. exact known infra codes    (anchored message prefixes / Node net codes)
 *   3. otherwise: a hard error (harness, deployment or grader problem)
 */

/** Structured `kind` values that denote infrastructure. */
export const INFRA_KINDS = new Set([
  "infra",
  "transport",
  "rate_limit",
  "auth",
  "network",
  "gateway",
  "timeout",
  "provider_unavailable",
  "model_unavailable",
  "missing_api_key",
]);

/**
 * Exact known infra signatures produced by the current transport / host.
 * Each regex is anchored at a line start so free text cannot trigger it.
 */
const KNOWN_INFRA_CODES = [
  { re: /^(?:Error: )?RATE_LIMIT:/m, kind: "rate_limit", code: "RATE_LIMIT" },
  { re: /^(?:Error: )?OpenAI-compatible error (401|403):/m, kind: "auth", code: "HTTP_$1" },
  { re: /^(?:Error: )?OpenAI-compatible error (429):/m, kind: "rate_limit", code: "HTTP_$1" },
  {
    re: /^(?:Error: )?OpenAI-compatible error (408|500|502|503|504):/m,
    kind: "gateway",
    code: "HTTP_$1",
  },
  { re: /^(?:Error: )?model unavailable: /m, kind: "model_unavailable", code: "MODEL_UNAVAILABLE" },
  { re: /^(?:TypeError: )?fetch failed\b/m, kind: "network", code: "FETCH_FAILED" },
  {
    re: /^(?:Error: )?(?:connect |read |getaddrinfo )?(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b/m,
    kind: "network",
    code: "$1",
  },
  // git seeding (SWE mirrors): network-level clone/fetch failures.
  {
    re: /^fatal: unable to access '[^']*': (Could not resolve host|Failed to connect|Connection timed out|Operation timed out|The requested URL returned error: 5\d\d)/m,
    kind: "network",
    code: "GIT_NETWORK",
  },
];

/**
 * @param {unknown} obj
 * @returns {{ infra: boolean, kind: string, code: string | null } | null}
 */
function fromStructured(obj) {
  if (!obj || typeof obj !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (obj);
  const kind = typeof o.kind === "string" ? o.kind : null;
  const code = o.code == null ? null : String(o.code);
  if (o.infra === true) return { infra: true, kind: kind ?? "infra", code };
  if (o.infra === false) return { infra: false, kind: kind ?? "error", code };
  if (kind && INFRA_KINDS.has(kind)) return { infra: true, kind, code };
  if (kind) return { infra: false, kind, code };
  return null;
}

/**
 * Scan text for one-line JSON error envelopes: {"fausth_error":{...}} or {"error":{...}}.
 * @param {string} text
 */
function structuredFromText(text) {
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^fausth-error:\s*/, "");
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const env = parsed?.fausth_error ?? parsed?.error;
    const hit = fromStructured(env);
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {{ error?: unknown, message?: string, stderr?: string, report?: Record<string, unknown> | null }} input
 * @returns {{ infra: boolean, kind: string, code: string | null, source: "structured" | "known_code" | "unclassified" }}
 */
export function classifyFailure(input = {}) {
  const structured =
    fromStructured(input.error) ??
    fromStructured(input.report?.error) ??
    fromStructured(input.report?.infra_error) ??
    structuredFromText(input.stderr) ??
    structuredFromText(input.message);
  if (structured) return { ...structured, source: "structured" };

  const text = `${input.message ?? ""}\n${input.stderr ?? ""}`;
  for (const { re, kind, code } of KNOWN_INFRA_CODES) {
    const m = re.exec(text);
    if (m) {
      return { infra: true, kind, code: code.replace("$1", m[1] ?? ""), source: "known_code" };
    }
  }
  return { infra: false, kind: "error", code: null, source: "unclassified" };
}

/**
 * Host-side infra failure for a missing provider key (structured at the source).
 * @param {string} envName
 */
export function missingApiKeyFailure(envName) {
  return { infra: true, kind: "missing_api_key", code: String(envName), source: "structured" };
}
