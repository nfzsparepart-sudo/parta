// Google SDK errors can carry RetryInfo inside their JSON message.
export function providerRetryDelayMs(error: unknown): number | undefined {
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
