export function shouldRetryProvider(status: number | undefined, message: string): boolean {
  // Quota, access, and credential errors need a fallback or user action, not a retry loop.
  if (status === 429 || /429|resource_exhausted|too many requests/i.test(message)) return false;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return (status !== undefined && status >= 500 && status <= 599) || /timed out/i.test(message);
}

// OpenAI supplies Retry-After headers; older provider errors may carry RetryInfo.
export function providerRetryDelayMs(error: unknown): number | undefined {
  const headers = (error as { headers?: { get?: (name: string) => string | null } } | null)?.headers;
  const retryMs = headers?.get?.("retry-after-ms");
  if (retryMs !== null && retryMs !== undefined && retryMs.trim() && Number.isFinite(Number(retryMs)) && Number(retryMs) >= 0)
    return Math.ceil(Number(retryMs));
  const retryAfter = headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  const value = error as { message?: string; errorDetails?: unknown[] } | null;
  let details = value?.errorDetails;
  if (!Array.isArray(details)) {
    try {
      const payload = JSON.parse(value?.message || "");
      details = payload.error?.details ?? payload.details;
    } catch { return undefined; }
  }
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    if (typeof detail !== "object" || detail === null) continue;
    const info = detail as { "@type"?: string; retryDelay?: string };
    if (!info["@type"]?.endsWith("google.rpc.RetryInfo")) continue;
    const match = String(info.retryDelay ?? "").match(/^(\d+(?:\.\d+)?)s$/);
    if (match) {
      const delay = Number(match[1]) * 1000;
      if (Number.isFinite(delay)) return Math.ceil(delay);
    }
  }
  return undefined;
}
