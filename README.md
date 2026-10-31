# Spare parts enrichment

Next.js app that imports Excel/CSV part numbers, researches them using the OpenAI Responses API with web search, reviews images supplied by SerpAPI, and exports Excel. Drafts and sessions remain in browser storage. Saudi terminology is supplemented by `saudidatabase.xlsx`.

## Setup and Vercel migration

Run `npm install`. Copy `.env.example` to `.env.local` and supply `OPENAI_API_KEY` and `SERPAPI_API_KEY`. Run `npm run dev`.

In Vercel, add `OPENAI_API_KEY` to Production (and Preview if needed), then deploy the latest commit. Never commit or share the key. Existing Gemini/Google environment variables are no longer used. Model access and funded OpenAI API billing are required; a ChatGPT subscription does not by itself guarantee API credits.

## Models and performance

`OPENAI_MODEL` defaults to `gpt-5.4-mini`, selected for a faster, economical batch workflow. `OPENAI_VISION_MODEL` defaults to the research model. Both can be overridden. `OPENAI_FALLBACK_MODELS` is a comma-separated list; empty by default to avoid extra paid calls. Both research and image reviews use strict JSON schemas. Research requires web search and retains provider citation URLs as clickable sources.

`NEXT_PUBLIC_MAX_CONCURRENT_OPENAI` defaults to 1. Rebuild deployments after changing this public variable. `OPENAI_TIMEOUT_MS` defaults to 25000 per API call, not per entire row. `OPENAI_MAX_RETRIES` defaults to 0 and SDK retries are disabled. Quota errors stop new browser jobs. Image reviews stop after a strong accepted match or an image quota failure; text output is retained if image review fails.

Source reliability is assigned by hostname; multiple pages or subdomains of one trusted source count once. Source coverage does not independently prove field correctness. Unknown remains preferable to unsupported fitment, weight, or manufacturing-country claims.

## Diagnostics and validation

`/api/openai-status` checks model metadata without generating text or searching. It reports deployment commit, model, key presence, and an error code; it never reveals the key. Successful metadata access does not prove generation credits are available. The old Gemini diagnostic route has been removed.

Run `npm test`, `npx tsc --noEmit`, and `npm run build`. Test known OEM records before bulk use. Research, web search, and image review can incur separate API charges.
