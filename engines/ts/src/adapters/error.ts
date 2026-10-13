/**
 * Shared adapter error type (binding / host resolution / host session failures).
 * Closed code set (D12). Adapter errors are infrastructure failures of the host, never
 * model behavior — callers should report them separately from model outcomes.
 */
export type AdapterErrorCode =
  | "binding_missing"
  | "adapter_unresolved"
  /** A deployment shipped inside a bundle asked to spawn a host command without operator allow. */
  | "spawn_not_allowed"
  /** Track A: no recorded response matches this exact call. */
  | "recorded_response_missing"
  /** User channel bound but unable to answer (no recorded answer, non-interactive human, simulator down). */
  | "user_channel_unavailable"
  /** A host session (stdio server, world command) failed or timed out. */
  | "host_session_failed";

export const ADAPTER_ERROR_CODES: readonly AdapterErrorCode[] = [
  "binding_missing",
  "adapter_unresolved",
  "spawn_not_allowed",
  "recorded_response_missing",
  "user_channel_unavailable",
  "host_session_failed",
];

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

export function isAdapterError(e: unknown): e is AdapterError {
  return e instanceof AdapterError;
}
