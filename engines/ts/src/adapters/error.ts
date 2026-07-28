/** Shared adapter error type (binding / host resolution failures). */
export type AdapterErrorCode = "binding_missing" | "adapter_unresolved";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}
