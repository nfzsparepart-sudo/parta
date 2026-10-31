import assert from "node:assert/strict";
import test from "node:test";
import { extractSearchUrls, enrichmentFormat } from "../app/lib/openai.ts";
import { providerRetryDelayMs } from "../app/lib/quota.ts";

test("OpenAI citations and search sources survive normalization without unsafe links", () => {
  const result = { output: [
    { type: "reasoning" },
    { type: "message", content: [{ type: "output_text", annotations: [
      { type: "url_citation", url: "https://partsouq.com/part" },
      { type: "url_citation", url: "javascript:alert(1)" },
    ] }] },
    { type: "web_search_call", action: { sources: [
      { url: "https://partsouq.com/part" }, { url: "https://amayama.com/part" },
    ] } },
  ] };
  assert.deepEqual(extractSearchUrls(result), ["https://partsouq.com/part", "https://amayama.com/part"]);
  assert.deepEqual(extractSearchUrls({}), []);
});

test("enrichment schema keeps row identity, Arabic columns, compatibility and evidence", () => {
  for (const key of ["source_row_id", "source_excel_row", "source_sku_raw", "name_ar", "name_ar_colloquial",
    "vehicle_brand_ar", "vehicle_model_ar", "compatibility", "sources", "source_urls"])
    assert.ok(enrichmentFormat.schema.required.includes(key));
});

test("OpenAI retry headers are preserved including fractional seconds", () => {
  assert.equal(providerRetryDelayMs({ headers: new Headers({ "retry-after": "2.5" }) }), 2500);
  assert.equal(providerRetryDelayMs({ headers: new Headers({ "retry-after-ms": "800" }) }), 800);
  assert.equal(providerRetryDelayMs({ headers: new Headers({ "retry-after": "invalid" }) }), undefined);
});
