import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as XLSX from "xlsx";
import path from "node:path";
import fs from "node:fs";

const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_MODELS = ["gemini-flash-latest", "gemini-2.0-flash-001"];
const SAUDI_DB_FILE = "saudidatabase.xlsx";

type EnrichedPart = {
  sku: string;
  name_en: string;
  name_ar: string;
  name_ar_colloquial: string;
  description: string;
  vehicle_brand: string;
  vehicle_model: string;
  vehicle_year: string;
  image_url: string;
  image_format: string;
  weight_unit: string;
  weight: string;
};

function cleanOutput(json: unknown, sku: string): EnrichedPart {
  const obj = (json as Record<string, unknown>) || {};

  return {
    sku,
    name_en: String(obj.name_en ?? ""),
    name_ar: String(obj.name_ar ?? ""),
    name_ar_colloquial: String(obj.name_ar_colloquial ?? ""),
    description: String(obj.description ?? ""),
    vehicle_brand: String(obj.vehicle_brand ?? ""),
    vehicle_model: String(obj.vehicle_model ?? ""),
    vehicle_year: String(obj.vehicle_year ?? "Unknown"),
    image_url: "",
    image_format: "",
    weight_unit: String(obj.weight_unit ?? "Unknown"),
    weight: String(obj.weight ?? ""),
  };
}

async function fetchImageFromSerpApi(
  query: string,
  overrideKey?: string
): Promise<{ image_url: string; image_format: string }> {
  const key = overrideKey;
  if (!key) {
    return { image_url: "Unknown", image_format: "Unknown" };
  }

  const endpoint = new URL("https://serpapi.com/search.json");
  endpoint.searchParams.set("engine", "google_images");
  endpoint.searchParams.set("api_key", key);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("num", "1");
  endpoint.searchParams.set("hl", "en");
  endpoint.searchParams.set("gl", "us");

  try {
    const res = await fetch(endpoint.toString(), { cache: "no-store" });
    if (!res.ok) {
      return { image_url: "Unknown", image_format: "Unknown" };
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const first = Array.isArray(payload.images_results)
      ? (payload.images_results[0] as Record<string, unknown> | undefined)
      : undefined;

    if (!first) {
      return { image_url: "Unknown", image_format: "Unknown" };
    }

    const rawUrl =
      first.original ??
      first.image ??
      first.url ??
      first.thumbnail ??
      first.source ??
      first.link;
    const imageUrl = String(rawUrl ?? "").trim();

    if (!imageUrl) {
      return { image_url: "Unknown", image_format: "Unknown" };
    }

    const parsed = new URL(imageUrl);
    const byPath = parsed.pathname.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]?.toLowerCase();
    const byParam =
      parsed.searchParams.get("format")?.toLowerCase() ||
      parsed.searchParams.get("fm")?.toLowerCase() ||
      "";
    const format = byPath || byParam || "unknown";

    return {
      image_url: imageUrl,
      image_format: format.toUpperCase(),
    };
  } catch {
    return { image_url: "Unknown", image_format: "Unknown" };
  }
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Model returned non-JSON output.");
    }
    return JSON.parse(match[0]);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let saudiColloquialMapCache: Map<string, string> | null = null;

function normalizeLookupText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findHeaderIndex(headers: string[], candidates: string[]): number {
  return headers.findIndex((h) => candidates.includes(normalizeLookupText(h)));
}

function getSaudiColloquialMap(): Map<string, string> {
  if (saudiColloquialMapCache) return saudiColloquialMapCache;

  const map = new Map<string, string>();
  const configuredPath = process.env.SAUDI_DATABASE_PATH?.trim();
  const candidates = [
    configuredPath,
    path.join(process.cwd(), SAUDI_DB_FILE),
    path.join("C:\\nfzjsgemini", SAUDI_DB_FILE),
    path.join("C:\\Users\\Nsh51\\Downloads", SAUDI_DB_FILE),
  ].filter(Boolean) as string[];

  const filePath = candidates.find((p) => {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });

  if (!filePath) {
    saudiColloquialMapCache = map;
    return map;
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.readFile(filePath);
  } catch {
    saudiColloquialMapCache = map;
    return map;
  }
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) {
    saudiColloquialMapCache = map;
    return map;
  }

  const ws = wb.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  if (!rows.length) {
    saudiColloquialMapCache = map;
    return map;
  }

  const headers = Object.keys(rows[0]).map((h) => String(h));
  const enIdx = findHeaderIndex(headers, ["part name (english)", "part name", "name_en", "english name"]);
  const arIdx = findHeaderIndex(headers, ["الاسم عربي", "name_ar", "arabic name"]);
  const colloquialIdx = findHeaderIndex(headers, ["الاسم العامي", "name_ar_colloquial", "saudi colloquial (ar)"]);

  if (colloquialIdx < 0 || (enIdx < 0 && arIdx < 0)) {
    saudiColloquialMapCache = map;
    return map;
  }

  const enHeader = enIdx >= 0 ? headers[enIdx] : "";
  const arHeader = arIdx >= 0 ? headers[arIdx] : "";
  const colloquialHeader = headers[colloquialIdx];

  for (const row of rows) {
    const colloquial = String(row[colloquialHeader] ?? "").trim();
    if (!colloquial) continue;

    if (enHeader) {
      const enKey = normalizeLookupText(row[enHeader]);
      if (enKey) map.set(enKey, colloquial);
    }

    if (arHeader) {
      const arKey = normalizeLookupText(row[arHeader]);
      if (arKey) map.set(arKey, colloquial);
    }
  }

  saudiColloquialMapCache = map;
  return map;
}

function resolveSaudiColloquial(nameEn: string, nameAr: string, currentColloquial: string): string {
  const map = getSaudiColloquialMap();
  if (!map.size) return currentColloquial || "Unknown";

  const byEn = map.get(normalizeLookupText(nameEn));
  if (byEn) return byEn;

  const byAr = map.get(normalizeLookupText(nameAr));
  if (byAr) return byAr;

  return currentColloquial || "Unknown";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sku = String(body?.sku ?? "").trim();
    const geminiApiKey = String(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "").trim();
    const serpApiKey = String(process.env.SERPAPI_API_KEY ?? "").trim();

    if (!sku) {
      return NextResponse.json({ error: "Missing 'sku' in request body." }, { status: 400 });
    }

    if (!geminiApiKey) {
      return NextResponse.json(
        { error: "Missing Gemini API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env.local / Vercel env." },
        { status: 500 }
      );
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const modelsToTry = Array.from(new Set([PRIMARY_MODEL, ...FALLBACK_MODELS]));

    const prompt = `
You are an automotive parts data enrichment expert.

Given this spare part SKU: ${sku}
Use grounded web search to find the most accurate details.

Return strict JSON with these keys only:
- sku
- name_en
- name_ar
- name_ar_colloquial
- description
- vehicle_brand
- vehicle_model
- vehicle_year
- weight_unit
- weight

Rules:
1) Keep sku exactly as input.
2) name_en: concise official English part name.
3) name_ar: formal Modern Standard Arabic automotive name.
4) name_ar_colloquial: Saudi colloquial automotive term commonly used in KSA workshops/market.
5) description: one short factual sentence.
6) vehicle_brand/model: return in Arabic script only (e.g., "تويوتا", "كامري"). If source is English, translate/transliterate to Arabic. If not discoverable, return "Unknown".
7) vehicle_year: model year or year range if discoverable, otherwise "Unknown".
8) weight_unit: one of kg, g, lb, oz when known, otherwise "Unknown".
9) weight: numeric value only when known, otherwise "Unknown".
10) Output valid JSON only. No markdown or code fences.
`;

    let raw = "";
    let lastError: unknown = null;

    for (const modelName of modelsToTry) {
      const model = genAI.getGenerativeModel({ model: modelName });
      try {
        const requestPayload: any = {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
          },
          tools: [{ googleSearch: {} }],
        };

        const result = await model.generateContent(requestPayload);

        raw = result.response.text();
        if (raw.trim()) break;
      } catch (e) {
        lastError = e;
        const status = (e as { status?: number })?.status;
        if (status === 503) {
          await sleep(1500);
          continue;
        }
        continue;
      }
    }

    if (!raw.trim()) {
      throw lastError || new Error("No response generated from available Gemini models.");
    }

    const parsed = extractJsonObject(raw);
    const cleaned = cleanOutput(parsed, sku);
    const imageQuery = [cleaned.name_en, cleaned.vehicle_brand, cleaned.vehicle_model, cleaned.sku]
      .filter((x) => x && x !== "Unknown")
      .join(" ");
    const imageData = await fetchImageFromSerpApi(imageQuery || sku, serpApiKey || undefined);
    const resolvedColloquial = resolveSaudiColloquial(
      cleaned.name_en,
      cleaned.name_ar,
      cleaned.name_ar_colloquial
    );

    return NextResponse.json({
      ...cleaned,
      name_ar_colloquial: resolvedColloquial,
      image_url: imageData.image_url,
      image_format: imageData.image_format,
    });
  } catch (error) {
    console.error("/api/enrich error:", error);
    const anyErr = error as {
      message?: string;
      status?: number;
      statusText?: string;
      errorDetails?: unknown;
    };

    const status = typeof anyErr?.status === "number" && anyErr.status >= 400 ? anyErr.status : 500;
    const details = anyErr?.message || "Failed to enrich SKU.";

    return NextResponse.json(
      {
        error: details,
        providerStatus: anyErr?.status || null,
        providerStatusText: anyErr?.statusText || null,
        providerDetails: anyErr?.errorDetails || null,
      },
      { status }
    );
  }
}
