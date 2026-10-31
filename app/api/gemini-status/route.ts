import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const dynamic = "force-dynamic";

// Checks model metadata only: no generation, search, or image-review requests.
export async function GET() {
  const source = process.env.GEMINI_API_KEY?.trim() ? "GEMINI_API_KEY" : "GOOGLE_API_KEY";
  const key = (process.env[source] || "").trim();
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
  const config = {
    deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local",
    model,
    keySource: source,
    keyConfigured: Boolean(key),
    keyType: key.startsWith("AQ.") ? "authorization" : key.startsWith("AIza") ? "standard" : "unrecognized",
    keyLength: key.length,
  };
  const respond = (data: object) => NextResponse.json({ ...config, ...data }, {
    headers: { "Cache-Control": "no-store" },
  });
  if (!key) return respond({ ok: false, reason: "MISSING_KEY" });
  if (/\s/.test(key) || /^["']|["']$/.test(key) || key.startsWith("GEMINI_API_KEY=")) {
    return respond({ ok: false, reason: "KEY_CONTAINS_WHITESPACE_QUOTES_OR_ASSIGNMENT" });
  }
  try {
    const client = new GoogleGenAI({ apiKey: key, vertexai: false });
    await client.models.get({ model, config: {
      httpOptions: { timeout: 10000, retryOptions: { attempts: 1 } },
    } });
    return respond({ ok: true, reason: "MODEL_METADATA_ACCESS_OK" });
  } catch (error) {
    const err = error as { status?: number; message?: string };
    let reason = "PROVIDER_CHECK_FAILED";
    // Expose only machine-readable reason codes, never provider messages or credentials.
    try {
      const body = JSON.parse(err.message || "{}");
      const detail = body.error?.details?.find((item: { reason?: string }) => item.reason);
      const candidate = detail?.reason || body.error?.status;
      if (typeof candidate === "string" && /^[A-Z_]+$/.test(candidate)) reason = candidate;
    } catch { /* Non-JSON network or timeout error. */ }
    return respond({ ok: false, providerStatus: err.status || null, reason });
  }
}
