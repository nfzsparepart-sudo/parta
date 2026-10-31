# Spare parts enrichment

Next.js app that imports Excel/CSV part numbers, enriches them using Gemini with Google Search grounding, reviews images from SerpAPI, and exports Excel. Drafts and sessions are stored in the browser. Saudi terminology is supplemented by `saudidatabase.xlsx`.

## Setup

Run `npm install`, copy `.env.example` to `.env.local`, supply valid keys, then run `npm run dev`. Never commit API keys. Set deployment environment variables separately.

## Gemini settings

Uses `@google/genai`. `GEMINI_MODEL` defaults to `gemini-3.8-flash`. `GEMINI_FALLBACK_MODELS` is a comma-separated list defaulting to `gemini-3.5-flash-lite`; an empty value disables fallback. `GEMINI_VISION_MODEL` optionally overrides image review and otherwise follows the primary model.

Enrichment retries transient failures and tries fallback models on failure or malformed JSON. Image review uses a JSON schema; failed reviews require human review. Source reliability comes from application-assigned hostname weights, with each trusted source counted once. This measures source coverage and does not prove individual field accuracy.

`NEXT_PUBLIC_MAX_CONCURRENT_GEMINI` controls concurrent rows (default 1). Each row can make one enrichment call plus up to five sequential image reviews (stopping early at an accepted image confidence of 90 or higher), with additional enrichment retries. Lower concurrency for quota errors. `GEMINI_TIMEOUT_MS` applies per generation, not per row. Restart after changing settings; rebuild deployments after changing public variables.

## Validation

Run `npm test`, `npx tsc --noEmit`, and `npm run build`. Live generation requires a valid API key, model access, and quota. Check real catalog output against known OEM records before bulk use.

On a final enrichment 429, the browser stops scheduling new rows and leaves unstarted rows unchanged. Retry delays from Google are respected up to GEMINI_MAX_BACKOFF_MS; longer waits move to the next fallback model rather than retrying too early. Already running rows can finish. This does not increase provider quota. Review project/model and Search limits in AI Studio, then run the remaining rows after capacity is available.
