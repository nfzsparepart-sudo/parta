const stringFields = [
  "sku", "source_row_id", "source_sku_raw", "source_sku_normalized", "source_note_raw",
  "manufacturer", "name_en", "name_ar", "name_ar_colloquial", "description",
  "installation_location", "side", "superseded_by", "manufacturer_country", "country",
  "vehicle_brand", "vehicle_brand_ar", "vehicle_model", "vehicle_model_ar", "vehicle_year",
  "weight_unit", "weight", "quality_notes",
];
const properties: Record<string, unknown> = Object.fromEntries(stringFields.map((key) => [key, { type: "string" }]));
for (const key of ["source_excel_row", "translation_confidence", "overall_confidence", "confidence"])
  properties[key] = { type: "number" };
for (const key of ["compatibility", "alternative_names", "issues", "source_urls"])
  properties[key] = { type: "array", items: { type: "string" } };
properties.review_required = { type: "boolean" };
properties.sources = {
  type: "array", items: {
    type: "object", additionalProperties: false,
    properties: { name: { type: "string" }, url: { type: "string" }, reliability: { type: "number" }, title: { type: "string" } },
    required: ["name", "url", "reliability", "title"],
  },
};

export const enrichmentFormat = {
  type: "json_schema" as const, name: "enriched_part", strict: true,
  schema: { type: "object", additionalProperties: false, properties, required: Object.keys(properties) },
};
export const visionFormat = {
  type: "json_schema" as const, name: "image_review", strict: true,
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      match_confidence: { type: "number" }, rejected: { type: "boolean" },
      issues: { type: "array", items: { type: "string" } }, notes: { type: "string" },
    },
    required: ["match_confidence", "rejected", "issues", "notes"],
  },
};

export function extractSearchUrls(result: unknown): string[] {
  const output = (result as { output?: unknown[] })?.output;
  if (!Array.isArray(output)) return [];
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    try { const url = new URL(value); if (["http:", "https:"].includes(url.protocol)) urls.add(url.href); } catch { /* Invalid URL. */ }
  };
  for (const item of output as Record<string, unknown>[]) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "output_text" && Array.isArray(part.annotations))
          for (const annotation of part.annotations) if (annotation.type === "url_citation") add(annotation.url);
      }
    }
    if (item.type === "web_search_call") {
      const action = item.action as { sources?: { url?: unknown }[] } | undefined;
      if (Array.isArray(action?.sources)) for (const source of action.sources) add(source.url);
    }
  }
  return [...urls].slice(0, 8);
}
