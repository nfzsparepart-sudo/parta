import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as XLSX from "xlsx";
import path from "node:path";
import fs from "node:fs";

const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-3.5-flash"];
const SAUDI_DB_FILE = "saudidatabase.xlsx";
const DEFAULT_GEMINI_TIMEOUT_MS = 45_000;
const DEFAULT_GEMINI_MAX_RETRIES = 4;
const DEFAULT_GEMINI_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_GEMINI_MAX_BACKOFF_MS = 15_000;
const MIN_REVIEW_CONFIDENCE = 90;
const MIN_IMAGE_SIZE = 500;
const IMAGE_CANDIDATE_LIMIT = 5;
const TRUSTED_SOURCES = [
  { name: "Nissan Parts Deal", domain: "nissanpartsdeal.com", weight: 100 },
  { name: "Toyota Parts Deal", domain: "toyotapartsdeal.com", weight: 100 },
  { name: "Ford Parts Giant", domain: "fordpartsgiant.com", weight: 98 },
  { name: "GM Parts Direct", domain: "gmpartsdirect.com", weight: 96 },
  { name: "Hyundai/Kia EPC", domain: "hyundai.oempartsonline.com", weight: 95 },
  { name: "Partsouq", domain: "partsouq.com", weight: 95 },
  { name: "Amayama", domain: "amayama.com", weight: 94 },
  { name: "RockAuto", domain: "rockauto.com", weight: 90 },
  { name: "eBay Motors", domain: "ebay.com", weight: 70 },
  { name: "Amazon Automotive", domain: "amazon.com", weight: 65 },
  { name: "Google Images", domain: "google.com", weight: 60 },
] as const;

type EnrichedPart = {
  sku: string;
  price: string;
  manufacturer: string;
  name_en: string;
  name_ar: string;
  name_ar_colloquial: string;
  description: string;
  installation_location: string;
  compatibility: string;
  alternative_names: string;
  side: string;
  superseded_by: string;
  manufacturer_country: string;
  country: string;
  vehicle_brand: string;
  vehicle_model: string;
  vehicle_year: string;
  image_url: string;
  image_format: string;
  image_confidence: string;
  translation_confidence: string;
  overall_confidence: string;
  issues: string;
  review_required: boolean;
  sources: string;
  weight_unit: string;
  weight: string;
  confidence: string;
  source_urls: string;
  missing_fields: string;
  needs_review: boolean;
  quality_notes: string;
};

type SourceEvidence = {
  name: string;
  url: string;
  reliability: number;
  title?: string;
};

type ImageCandidate = {
  image_url: string;
  image_format: string;
  source_url: string;
  title: string;
  width: number;
  height: number;
  source_reliability: number;
};

type VisionReview = {
  image_url: string;
  image_format: string;
  image_confidence: number;
  rejected: boolean;
  issues: string[];
  notes: string;
};

function cleanText(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeUnknown(value: unknown): string {
  const text = cleanText(value, "Unknown");
  return /^(unknown|n\/a|na|null|undefined|-+)$/i.test(text) ? "Unknown" : text;
}

function normalizeNumeric(value: unknown): string {
  const text = normalizeUnknown(value);
  if (text === "Unknown") return text;
  const match = text.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? match[0] : "Unknown";
}

function normalizeYear(value: unknown): string {
  const text = normalizeUnknown(value);
  if (text === "Unknown") return text;
  const years = text.match(/\b(?:19|20)\d{2}\b/g);
  if (!years?.length) return "Unknown";
  return years.length >= 2 ? `${years[0]}-${years[years.length - 1]}` : years[0];
}

function normalizeWeightUnit(value: unknown): string {
  const text = normalizeUnknown(value).toLowerCase();
  if (text === "unknown") return "Unknown";
  return ["kg", "g", "lb", "oz"].includes(text) ? text : "Unknown";
}

function hasArabic(value: string): boolean {
  return /[\u0600-\u06FF]/.test(value);
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => cleanText(v)).filter(Boolean);
  return cleanText(value)
    .split(/[\n,|]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function clampConfidence(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(Math.max(0, Math.min(100, Math.round(n))));
}

function confidenceNumber(value: unknown): number {
  return Number(clampConfidence(value));
}

function normalizeIssue(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function sourceReliability(url: string): number {
  const lower = url.toLowerCase();
  return TRUSTED_SOURCES.find((source) => lower.includes(source.domain))?.weight ?? 40;
}

function sourceName(url: string): string {
  const lower = url.toLowerCase();
  return TRUSTED_SOURCES.find((source) => lower.includes(source.domain))?.name ?? "Other";
}

function normalizeSources(value: unknown, fallbackUrls: string[] = []): SourceEvidence[] {
  const rawSources = Array.isArray(value) ? value : [];
  const sources: SourceEvidence[] = [];

  for (const item of rawSources) {
    if (typeof item === "string") {
      sources.push({
        name: sourceName(item),
        url: item,
        reliability: sourceReliability(item),
      });
      continue;
    }

    const obj = (item as Record<string, unknown>) || {};
    const url = cleanText(obj.url || obj.source_url || obj.uri);
    if (!url) continue;
    sources.push({
      name: cleanText(obj.name, sourceName(url)),
      url,
      reliability: Math.max(sourceReliability(url), Number(obj.reliability ?? 0) || 0),
      title: cleanText(obj.title),
    });
  }

  for (const url of fallbackUrls) {
    sources.push({
      name: sourceName(url),
      url,
      reliability: sourceReliability(url),
    });
  }

  return sources
    .sort((a, b) => b.reliability - a.reliability)
    .filter((source, index, all) => all.findIndex((candidate) => candidate.url === source.url) === index)
    .slice(0, 8);
}

function serializeSources(sources: SourceEvidence[]): string {
  return sources.map((source) => `${source.name} (${source.reliability}): ${source.url}`).join(" | ");
}

function detectSide(value: string): "LEFT" | "RIGHT" | "UNKNOWN" {
  const text = value.toLowerCase();
  const left = /\b(lh|left|driver side|driver-side|driver)\b/.test(text);
  const right = /\b(rh|right|passenger side|passenger-side|passenger)\b/.test(text);
  if (left && !right) return "LEFT";
  if (right && !left) return "RIGHT";
  return "UNKNOWN";
}

function mergeIssues(...groups: Array<Array<string | undefined>>): string[] {
  return uniqueStrings(groups.flat().filter((issue): issue is string => Boolean(issue)).map(normalizeIssue));
}

const SAUDI_TERMS: Array<[RegExp, string]> = [
  [/brake pads?/i, "فحمات"],
  [/retainer clips?/i, "كبس"],
  [/radiators?/i, "رديتر"],
  [/mirror assembly/i, "مراية جانبية كاملة"],
  [/splash shields?/i, "بطانة رفرف"],
  [/engine mounts?/i, "قاعدة مكينة"],
  [/air intake hoses?/i, "لي سحب الهواء"],
  [/power steering pressure hoses?/i, "لي ضغط الباور"],
  [/transmission mounts?/i, "قاعدة قير"],
  [/condensers?/i, "رديتر مكيف"],
];

function applySaudiTermOverride(nameEn: string, currentColloquial: string): string {
  const match = SAUDI_TERMS.find(([pattern]) => pattern.test(nameEn));
  return match?.[1] || currentColloquial || "Unknown";
}

function normalizeCompatibility(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        const obj = (item as Record<string, unknown>) || {};
        return [obj.make, obj.model, obj.generation, obj.year || obj.years]
          .map((part) => cleanText(part))
          .filter(Boolean)
          .join(" ");
      })
      .filter(Boolean);
  }

  return normalizeStringList(value);
}

function cleanOutput(json: unknown, sku: string): EnrichedPart {
  const obj = (json as Record<string, unknown>) || {};
  const compatibility = normalizeCompatibility(obj.compatibility);
  const sources = normalizeSources(obj.sources || obj.source_urls);
  const issues = normalizeStringList(obj.issues).map(normalizeIssue);
  const translationConfidence = confidenceNumber(obj.translation_confidence || obj.confidence);
  const overallConfidence = confidenceNumber(obj.overall_confidence || obj.confidence);
  const cleaned = {
    sku,
    price: "",
    manufacturer: normalizeUnknown(obj.manufacturer),
    name_en: cleanText(obj.name_en),
    name_ar: normalizeUnknown(obj.name_ar),
    name_ar_colloquial: normalizeUnknown(obj.name_ar_colloquial),
    description: cleanText(obj.description),
    installation_location: normalizeUnknown(obj.installation_location),
    compatibility: compatibility.join(" | "),
    alternative_names: normalizeStringList(obj.alternative_names).join(" | "),
    side: normalizeUnknown(obj.side),
    superseded_by: normalizeUnknown(obj.superseded_by || obj.replacement_sku),
    manufacturer_country: normalizeUnknown(obj.manufacturer_country),
    country: normalizeUnknown(obj.country || obj.manufacturer_country),
    vehicle_brand: normalizeUnknown(obj.vehicle_brand),
    vehicle_model: normalizeUnknown(obj.vehicle_model),
    vehicle_year: normalizeYear(obj.vehicle_year),
    image_url: "",
    image_format: "",
    image_confidence: "0",
    translation_confidence: String(translationConfidence),
    overall_confidence: String(overallConfidence),
    issues: issues.join(", "),
    review_required: Boolean(obj.review_required) || overallConfidence < MIN_REVIEW_CONFIDENCE,
    sources: serializeSources(sources),
    weight_unit: normalizeWeightUnit(obj.weight_unit),
    weight: normalizeNumeric(obj.weight),
    confidence: String(overallConfidence),
    source_urls: uniqueStrings([...normalizeStringList(obj.source_urls), ...sources.map((source) => source.url)]).join(" | "),
    missing_fields: "",
    needs_review: false,
    quality_notes: cleanText(obj.quality_notes),
  };

  const missingFields = ([
    "manufacturer",
    "name_en",
    "name_ar",
    "name_ar_colloquial",
    "description",
    "installation_location",
    "compatibility",
    "manufacturer_country",
    "vehicle_brand",
    "vehicle_model",
    "vehicle_year",
    "weight_unit",
    "weight",
  ] as const).filter((field) => !cleaned[field] || cleaned[field] === "Unknown");

  const notes = new Set<string>();
  if (cleaned.name_ar !== "Unknown" && !hasArabic(cleaned.name_ar)) notes.add("name_ar is not Arabic");
  if (cleaned.name_ar_colloquial !== "Unknown" && !hasArabic(cleaned.name_ar_colloquial)) {
    notes.add("name_ar_colloquial is not Arabic");
  }
  if (cleaned.vehicle_brand !== "Unknown" && !hasArabic(cleaned.vehicle_brand)) notes.add("vehicle_brand is not Arabic");
  if (cleaned.vehicle_model !== "Unknown" && !hasArabic(cleaned.vehicle_model)) notes.add("vehicle_model is not Arabic");
  if (!cleaned.source_urls) notes.add("no source URL returned");
  if (Number(cleaned.confidence) < MIN_REVIEW_CONFIDENCE) notes.add("low confidence");
  if (missingFields.length) notes.add(`missing: ${missingFields.join(", ")}`);

  return {
    ...cleaned,
    missing_fields: missingFields.join(", "),
    needs_review: notes.size > 0 || cleaned.review_required,
    review_required: notes.size > 0 || cleaned.review_required,
    quality_notes: [cleaned.quality_notes, ...notes].filter(Boolean).join(" | "),
  };
}

async function fetchImageCandidatesFromSerpApi(
  query: string,
  terms: string[],
  overrideKey?: string
): Promise<ImageCandidate[]> {
  const allowedFormats = new Set(["jpg", "jpeg", "png", "webp", "gif"]);
  const key = overrideKey;
  if (!key) {
    return [];
  }

  const endpoint = new URL("https://serpapi.com/search.json");
  endpoint.searchParams.set("engine", "google_images");
  endpoint.searchParams.set("api_key", key);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("num", "10");
  endpoint.searchParams.set("hl", "en");
  endpoint.searchParams.set("gl", "us");

  try {
    const res = await fetch(endpoint.toString(), { cache: "no-store" });
    if (!res.ok) {
      return [];
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const results = Array.isArray(payload.images_results)
      ? (payload.images_results as Record<string, unknown>[])
      : [];
    if (!results.length) {
      return [];
    }
    const scored = results
      .map((item) => {
        const haystack = [item.title, item.source, item.link, item.original, item.image, item.thumbnail]
          .map((v) => String(v ?? "").toLowerCase())
          .join(" ");
        const score = terms.reduce((sum, term) => {
          const normalized = term.trim().toLowerCase();
          return normalized && haystack.includes(normalized) ? sum + 1 : sum;
        }, 0);
        return { item, score };
      })
      .sort((a, b) => b.score - a.score);

    const candidates: ImageCandidate[] = [];
    for (const { item } of scored) {
      const rawUrl =
        item.original ??
        item.image ??
        item.url ??
        item.thumbnail ??
        item.source ??
        item.link;
      const imageUrl = String(rawUrl ?? "").trim();
      if (!imageUrl) continue;

      let parsed: URL;
      try {
        parsed = new URL(imageUrl);
      } catch {
        continue;
      }

      const byPath = parsed.pathname.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]?.toLowerCase();
      const byParam =
        parsed.searchParams.get("format")?.toLowerCase() ||
        parsed.searchParams.get("fm")?.toLowerCase() ||
        "";
      const format = byPath || byParam || "unknown";
      if (!allowedFormats.has(format)) continue;

      const sourceUrl = cleanText(item.link || item.source || imageUrl);
      candidates.push({
        image_url: imageUrl,
        image_format: format.toUpperCase(),
        source_url: sourceUrl,
        title: cleanText(item.title),
        width: Number(item.original_width ?? item.width ?? 0) || 0,
        height: Number(item.original_height ?? item.height ?? 0) || 0,
        source_reliability: sourceReliability(sourceUrl),
      });

      if (candidates.length >= IMAGE_CANDIDATE_LIMIT) break;
    }

    return candidates;
  } catch {
    return [];
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

function extractGroundingUrls(result: unknown): string[] {
  const candidates = (result as { response?: { candidates?: unknown[] } })?.response?.candidates;
  if (!Array.isArray(candidates)) return [];

  const urls = new Set<string>();
  for (const candidate of candidates as Record<string, unknown>[]) {
    const metadata = candidate.groundingMetadata as { groundingChunks?: unknown[] } | undefined;
    const chunks = metadata?.groundingChunks;
    if (!Array.isArray(chunks)) continue;

    for (const chunk of chunks as Record<string, unknown>[]) {
      const web = chunk.web as { uri?: unknown } | undefined;
      const uri = cleanText(web?.uri);
      if (uri) urls.add(uri);
    }
  }

  return Array.from(urls).slice(0, 5);
}

async function fetchImageAsInlineData(url: string): Promise<{ mimeType: string; data: string; size: number } | null> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; NefzalikPartValidator/1.0; +https://example.com/automotive-parts-validation)",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return null;
    const arrayBuffer = await res.arrayBuffer();
    return {
      mimeType: contentType.split(";")[0] || "image/jpeg",
      data: Buffer.from(arrayBuffer).toString("base64"),
      size: arrayBuffer.byteLength,
    };
  } catch {
    return null;
  }
}

async function reviewImageCandidate(
  genAI: GoogleGenerativeAI,
  candidate: ImageCandidate,
  context: EnrichedPart,
  timeoutMs: number
): Promise<VisionReview> {
  const issues: string[] = [];
  if (candidate.width && candidate.height && (candidate.width < MIN_IMAGE_SIZE || candidate.height < MIN_IMAGE_SIZE)) {
    issues.push("LOW_RESOLUTION");
  }

  const inlineData = await fetchImageAsInlineData(candidate.image_url);
  if (!inlineData) {
    return {
      image_url: candidate.image_url,
      image_format: candidate.image_format,
      image_confidence: 0,
      rejected: true,
      issues: mergeIssues(issues, ["IMAGE_DOWNLOAD_FAILED"]),
      notes: "Could not download candidate image for vision review.",
    };
  }

  const model = genAI.getGenerativeModel({ model: PRIMARY_MODEL });
  const prompt = `
You are validating an automotive spare part image for catalog quality control.

SKU: ${context.sku}
English title: ${context.name_en}
Arabic title: ${context.name_ar}
Saudi colloquial term: ${context.name_ar_colloquial}
Expected side: ${context.side}
Expected compatibility: ${context.compatibility}
Expected installation location: ${context.installation_location}

Reject the image if it has a watermark, collage layout, multiple unrelated parts, kit instead of single part, wrong category, wrong side/orientation, or low catalog usefulness.

Return strict JSON only:
{
  "match_confidence": 0,
  "rejected": true,
  "issues": [],
  "notes": ""
}
`;

  try {
    const result = await withTimeout(
      model.generateContent([
        { text: prompt },
        {
          inlineData: {
            mimeType: inlineData.mimeType,
            data: inlineData.data,
          },
        },
      ] as any),
      timeoutMs
    );
    const parsed = extractJsonObject(result.response.text()) as Record<string, unknown>;
    const visionIssues = normalizeStringList(parsed.issues).map(normalizeIssue);
    return {
      image_url: candidate.image_url,
      image_format: candidate.image_format,
      image_confidence: confidenceNumber(parsed.match_confidence),
      rejected: Boolean(parsed.rejected),
      issues: mergeIssues(issues, visionIssues),
      notes: cleanText(parsed.notes),
    };
  } catch {
    return {
      image_url: candidate.image_url,
      image_format: candidate.image_format,
      image_confidence: Math.max(20, candidate.source_reliability - 30),
      rejected: true,
      issues: mergeIssues(issues, ["VISION_REVIEW_FAILED"]),
      notes: "Vision review failed for candidate image.",
    };
  }
}

async function selectValidatedImage(
  genAI: GoogleGenerativeAI,
  candidates: ImageCandidate[],
  context: EnrichedPart,
  timeoutMs: number
): Promise<VisionReview> {
  if (!candidates.length) {
    return {
      image_url: "Unknown",
      image_format: "Unknown",
      image_confidence: 0,
      rejected: true,
      issues: ["MISSING_IMAGE"],
      notes: "No image candidates found.",
    };
  }

  const reviews: VisionReview[] = [];
  for (const candidate of candidates.slice(0, IMAGE_CANDIDATE_LIMIT)) {
    reviews.push(await reviewImageCandidate(genAI, candidate, context, timeoutMs));
  }

  const accepted = reviews
    .filter((review) => !review.rejected && review.image_confidence >= 70)
    .sort((a, b) => b.image_confidence - a.image_confidence);

  return accepted[0] || reviews.sort((a, b) => b.image_confidence - a.image_confidence)[0];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvInt(value: string | undefined, fallback: number, min = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function isRetryableStatus(status: number | undefined): boolean {
  if (!status) return false;
  if (status === 429 || status === 503) return true;
  return status >= 500 && status <= 599;
}

function formatProviderError(error: unknown): { message: string; status: number } {
  const anyErr = error as {
    message?: string;
    status?: number;
    statusText?: string;
  };
  const rawMessage = String(anyErr?.message ?? "Failed to enrich SKU.");
  const status = typeof anyErr?.status === "number" && anyErr.status >= 400 ? anyErr.status : 500;
  const lower = rawMessage.toLowerCase();

  if (
    status === 429 ||
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("exceeded your current quota")
  ) {
    return {
      status: 429,
      message:
        "Gemini quota/rate limit reached (429). The app retried automatically but no capacity was available. Check plan/billing and quota usage at https://ai.dev/rate-limit and https://ai.google.dev/gemini-api/docs/rate-limits, then retry.",
    };
  }

  if (
    status === 503 ||
    lower.includes("503") ||
    lower.includes("service unavailable") ||
    lower.includes("high demand")
  ) {
    return {
      status: 503,
      message:
        "Gemini is temporarily overloaded (503 high demand). The app retried automatically and tried fallback models. Retry the failed rows in a few minutes or lower NEXT_PUBLIC_MAX_CONCURRENT_GEMINI.",
    };
  }

  return { message: rawMessage, status };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(`Gemini request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(id);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(id);
        reject(error);
      });
  });
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
    const timeoutMs = parseEnvInt(process.env.GEMINI_TIMEOUT_MS, DEFAULT_GEMINI_TIMEOUT_MS);
    const maxRetries = parseEnvInt(process.env.GEMINI_MAX_RETRIES, DEFAULT_GEMINI_MAX_RETRIES);
    const initialBackoffMs = parseEnvInt(
      process.env.GEMINI_INITIAL_BACKOFF_MS,
      DEFAULT_GEMINI_INITIAL_BACKOFF_MS
    );
    const maxBackoffMs = parseEnvInt(process.env.GEMINI_MAX_BACKOFF_MS, DEFAULT_GEMINI_MAX_BACKOFF_MS);

    const trustedSourceText = TRUSTED_SOURCES.map(
      (source) => `${source.name} (${source.domain}, reliability ${source.weight})`
    ).join("; ");
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
- manufacturer_country
- vehicle_brand
- vehicle_model
- vehicle_year
- weight_unit
- weight
- confidence
- source_urls
- quality_notes

Rules:
1) Keep sku exactly as input.
2) Do not search for, infer, or return price. Price is supplied only by the uploaded Excel/CSV file.
3) name_en: concise official English part name.
4) name_ar: formal Modern Standard Arabic automotive name.
5) name_ar_colloquial: Saudi colloquial automotive term commonly used in KSA workshops/market.
6) description: one short factual sentence.
7) manufacturer_country: country where the part is manufactured (e.g., 'China', 'Japan'), otherwise 'Unknown'.
8) vehicle_brand/model: return in Arabic script only (e.g., "تويوتا", "كامري"). If source is English, translate/transliterate to Arabic. If not discoverable, return "Unknown".
9) vehicle_year: model year or year range if discoverable, otherwise "Unknown".
10) weight_unit: one of kg, g, lb, oz when known, otherwise "Unknown".
11) weight: numeric value only when known, otherwise "Unknown".
12) confidence: integer 0-100 based on source quality and SKU match.
13) source_urls: array of up to 5 URLs used to support the answer.
14) quality_notes: short note for uncertain or conflicting fields, otherwise empty string.
15) Do not guess. Use "Unknown" when a field is not directly supported by search results.
16) Output valid JSON only. No markdown or code fences.
`;
    const validationPrompt = `
You are a strict automotive spare parts catalog validator for Saudi Arabia.

SKU: ${sku}

Search and merge evidence from these sources when relevant, ranked by reliability:
${trustedSourceText}

Quality rules:
1) Prioritize OEM/EPC and official catalog sources over marketplace pages.
2) Cross-check vehicle compatibility across at least 3 trusted sources when possible.
3) Normalize compatibility as "Make Model Generation Year-Year", e.g. "Nissan Sunny B13 1987-1998".
4) Detect side/orientation from SKU, manufacturer title, description, and source text: LH, RH, Left, Right, Driver Side, Passenger Side.
5) If side evidence conflicts, add issue "SIDE_MISMATCH".
6) Detect duplicate and superseded part numbers. If superseded, set superseded_by.
7) Use Saudi automotive terminology, not literal translation. Examples: Brake Pads = فحمات, Retainer Clip = كبس, Radiator = رديتر, Mirror Assembly = مراية جانبية كاملة, Splash Shield = بطانة رفرف, Engine Mount = قاعدة مكينة, Air Intake Hose = لي سحب الهواء, Power Steering Pressure Hose = لي ضغط الباور, Transmission Mount = قاعدة قير, Condenser = رديتر مكيف.
8) Generate useful Arabic title, English title, short description, installation location, compatibility, and alternative names.
9) Do not search for, infer, or return price. Price is supplied only by the uploaded Excel/CSV file.
10) Prefer Unknown and add a quality issue instead of guessing.

Return strict JSON only with these keys:
{
  "sku": "",
  "manufacturer": "",
  "name_en": "",
  "name_ar": "",
  "name_ar_colloquial": "",
  "description": "",
  "installation_location": "",
  "compatibility": [],
  "alternative_names": [],
  "side": "LEFT|RIGHT|UNKNOWN",
  "superseded_by": "",
  "manufacturer_country": "",
  "country": "",
  "vehicle_brand": "",
  "vehicle_model": "",
  "vehicle_year": "",
  "weight_unit": "kg|g|lb|oz|Unknown",
  "weight": "",
  "translation_confidence": 0,
  "overall_confidence": 0,
  "confidence": 0,
  "issues": [],
  "review_required": true,
  "sources": [{"name":"","url":"","reliability":0,"title":""}],
  "source_urls": [],
  "quality_notes": ""
}

Confidence scoring must be 0-100 and based on source agreement, compatibility agreement, side agreement, translation quality, and completeness. Set review_required true if confidence < 90 or if issues are present.
`;

    let raw = "";
    let totalRetriesUsed = 0;
    let lastError: unknown = null;
    let sourceUrls: string[] = [];

    for (const modelName of modelsToTry) {
      const model = genAI.getGenerativeModel({ model: modelName });
      const requestPayload: any = {
        contents: [{ role: "user", parts: [{ text: validationPrompt }] }],
        generationConfig: {
          temperature: 0.2,
        },
        tools: [{ googleSearch: {} }],
      };

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await withTimeout(model.generateContent(requestPayload), timeoutMs);
          raw = result.response.text();
          sourceUrls = extractGroundingUrls(result);
          if (raw.trim()) break;
          throw new Error("Gemini returned empty response text.");
        } catch (e) {
          const message = String((e as { message?: string })?.message ?? "").toLowerCase();
          const status = (e as { status?: number })?.status;
          const isDeprecatedModelError =
            message.includes("no longer available to new users") ||
            message.includes("not found") ||
            message.includes("404");
          const retryable = isRetryableStatus(status) || message.includes("timed out");

          if (!isDeprecatedModelError) lastError = e;
          if (!retryable || attempt === maxRetries) break;

          const capped = Math.min(initialBackoffMs * 2 ** attempt, maxBackoffMs);
          const jitter = Math.floor(Math.random() * 500);
          totalRetriesUsed += 1;
          await sleep(capped + jitter);
        }
      }
      if (raw.trim()) break;
    }

    if (!raw.trim()) {
      throw lastError || new Error(`No response generated from available Gemini models: ${modelsToTry.join(", ")}`);
    }

    const parsed = extractJsonObject(raw);
    const cleaned = cleanOutput(parsed, sku);
    const mergedSources = normalizeSources((parsed as Record<string, unknown>)?.sources, [
      ...normalizeStringList(cleaned.source_urls),
      ...sourceUrls,
    ]);
    const mergedSourceUrls = mergedSources.map((source) => source.url).slice(0, 8);
    const resolvedColloquial = applySaudiTermOverride(
      cleaned.name_en,
      resolveSaudiColloquial(cleaned.name_en, cleaned.name_ar, cleaned.name_ar_colloquial)
    );
    const sideSignals = [
      detectSide(cleaned.sku),
      detectSide(cleaned.name_en),
      detectSide(cleaned.description),
      detectSide(cleaned.side),
    ].filter((side) => side !== "UNKNOWN");
    const sideMismatch = new Set(sideSignals).size > 1;
    const imageTerms = [cleaned.sku, cleaned.name_en, cleaned.manufacturer, cleaned.vehicle_brand, cleaned.vehicle_model].filter(
      (x) => x && x !== "Unknown"
    );
    const imageQuery = imageTerms
      .filter((x) => x && x !== "Unknown")
      .join(" ");
    const imageCandidates = await fetchImageCandidatesFromSerpApi(imageQuery || sku, imageTerms, serpApiKey || undefined);
    const imageReview = await selectValidatedImage(genAI, imageCandidates, {
      ...cleaned,
      name_ar_colloquial: resolvedColloquial,
    }, timeoutMs);
    const issues = mergeIssues(
      normalizeStringList(cleaned.issues),
      imageReview.issues,
      sideMismatch ? ["SIDE_MISMATCH"] : [],
      imageReview.rejected ? ["WRONG_IMAGE"] : [],
      !cleaned.compatibility || cleaned.compatibility === "Unknown" ? ["MISSING_COMPATIBILITY"] : [],
      !hasArabic(cleaned.name_ar) || !hasArabic(resolvedColloquial) ? ["TRANSLATION_MISMATCH"] : [],
      cleaned.superseded_by && cleaned.superseded_by !== "Unknown" ? ["SUPERSEDED_SKU"] : []
    );
    const missingFields = cleaned.missing_fields
      .split(",")
      .map((field) => field.trim())
      .filter((field) => field && !(field === "name_ar_colloquial" && resolvedColloquial !== "Unknown"));
    if (imageReview.image_url === "Unknown" && !missingFields.includes("image_url")) {
      missingFields.push("image_url");
    }
    const qualityNotes = cleaned.quality_notes
      .split("|")
      .map((note) => note.trim())
      .filter((note) => note && !note.startsWith("missing:"))
      .filter((note) => !(note === "no source URL returned" && mergedSourceUrls.length > 0))
      .filter((note) => !(note.includes("name_ar_colloquial") && resolvedColloquial !== "Unknown"));
    if (missingFields.length) qualityNotes.push(`missing: ${missingFields.join(", ")}`);
    if (imageReview.rejected) qualityNotes.push(imageReview.notes || "image rejected by validation");
    if (sideMismatch) qualityNotes.push("side evidence mismatch");
    const sourceAgreement = Math.min(100, mergedSources.filter((source) => source.reliability >= 90).length * 34);
    const compatibilityConfidence = cleaned.compatibility && cleaned.compatibility !== "Unknown" ? sourceAgreement : 0;
    const translationConfidence = confidenceNumber(cleaned.translation_confidence);
    const overallConfidence = Math.round(
      imageReview.image_confidence * 0.25 +
        translationConfidence * 0.2 +
        sourceAgreement * 0.25 +
        compatibilityConfidence * 0.2 +
        (sideMismatch ? 0 : 100) * 0.1
    );
    const reviewRequired =
      overallConfidence < MIN_REVIEW_CONFIDENCE ||
      issues.length > 0 ||
      qualityNotes.length > 0 ||
      imageReview.rejected ||
      sideMismatch;

    return NextResponse.json({
      ...cleaned,
      name_ar_colloquial: resolvedColloquial,
      image_url: imageReview.rejected ? "Unknown" : imageReview.image_url,
      image_format: imageReview.rejected ? "Unknown" : imageReview.image_format,
      image_confidence: String(imageReview.image_confidence),
      translation_confidence: String(translationConfidence),
      overall_confidence: String(overallConfidence),
      confidence: String(overallConfidence),
      issues,
      review_required: reviewRequired,
      sources: mergedSources,
      source_urls: mergedSourceUrls.join(" | "),
      missing_fields: missingFields.join(", "),
      needs_review: reviewRequired,
      quality_notes: qualityNotes.join(" | "),
      retryCount: totalRetriesUsed,
    });
  } catch (error) {
    console.error("/api/enrich error:", error);
    const anyErr = error as {
      message?: string;
      status?: number;
      statusText?: string;
      errorDetails?: unknown;
    };
    const normalized = formatProviderError(error);

    return NextResponse.json(
      {
        error: normalized.message,
        providerStatus: anyErr?.status || null,
        providerStatusText: anyErr?.statusText || null,
        providerDetails: anyErr?.errorDetails || null,
      },
      { status: normalized.status }
    );
  }
}

