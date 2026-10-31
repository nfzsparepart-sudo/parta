import { NextResponse } from "next/server";
import OpenAI from "openai";

export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.OPENAI_API_KEY?.trim() || "";
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
  const config = {
    provider: "openai", deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local",
    model, keyConfigured: Boolean(key),
  };
  const respond = (data: object) => NextResponse.json({ ...config, ...data }, { headers: { "Cache-Control": "no-store" } });
  if (!key) return respond({ ok: false, reason: "MISSING_OPENAI_API_KEY" });
  if (/\s/.test(key) || /^["']|["']$/.test(key) || key.startsWith("OPENAI_API_KEY="))
    return respond({ ok: false, reason: "KEY_CONTAINS_WHITESPACE_QUOTES_OR_ASSIGNMENT" });
  try {
    const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 10000 });
    await client.models.retrieve(model);
    return respond({ ok: true, reason: "MODEL_METADATA_ACCESS_OK", note: "Metadata access does not verify generation credits or web-search access." });
  } catch (error) {
    const err = error as { status?: number; code?: string };
    return respond({ ok: false, providerStatus: err.status || null,
      reason: typeof err.code === "string" && /^[a-zA-Z_]+$/.test(err.code) ? err.code : "PROVIDER_CHECK_FAILED" });
  }
}
