const names = new Set([
  "TimeoutError",
  "FetchError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
]);
const aborts = new Set(["AbortError", "APIUserAbortError"]);
const codes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);
type Shape = {
  status?: unknown;
  code?: unknown;
  name?: unknown;
  cause?: { code?: unknown } | null;
};

export function transient(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code, name, cause } = error as Shape;
  const kinds = [name, error.constructor.name];
  if (kinds.some((kind) => aborts.has(String(kind)))) return false;
  if (typeof status === "number")
    return status === 408 || status === 429 || status >= 500;
  return (
    kinds.some((kind) => names.has(String(kind))) ||
    [code, cause?.code].some(
      (value) =>
        typeof value === "string" &&
        (codes.has(value) || value.startsWith("UND_ERR_")),
    )
  );
}
