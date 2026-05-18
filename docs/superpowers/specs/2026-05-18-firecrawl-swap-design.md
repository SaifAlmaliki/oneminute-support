# Firecrawl swap (replace ZenRows) — Design

**Date:** 2026-05-18
**Status:** Approved (pending implementation)
**Scope:** Replace ZenRows with Firecrawl as the website-scraping provider for the knowledge ingestion flow.

## Background

ZenRows is currently used in exactly one place: the `type === "website"` branch of `app/api/knowledge/store/route.ts` (lines 64–87). It fetches a URL and returns markdown, which is then fed into `summarizeMarkdown` and stored in `knowledge_source.content`.

`FIRECRAWL_API_KEY` has already been added to `.env`. The `@mendable/firecrawl-js` SDK is **not** installed and will not be installed — we will call the Firecrawl v2 REST API directly via `fetch`, mirroring the current code style.

## Goals

- Replace the ZenRows call with a Firecrawl v2 `/scrape` call.
- Remove ZenRows entirely from the codebase, env, and docs.
- Fix the existing always-truthy error check (`if (!res.text)`) as part of the rewrite.

## Non-goals

- No provider abstraction layer.
- No fallback to ZenRows.
- No SDK dependency.
- No retry logic.
- No chunking, embeddings, or HTML parsing changes — Firecrawl returns markdown directly, which slots into the existing `summarizeMarkdown` step unchanged.
- No changes to the `text` or `upload` branches of the route, the embed flow, the chat flow, or `lib/openAI.ts`.

## Design

### Code change — `app/api/knowledge/store/route.ts`

Replace the ZenRows URL construction + GET (current lines 64–87) with a `POST` to `https://api.firecrawl.dev/v2/scrape`:

- **Method:** `POST`
- **Headers:**
  - `Authorization: Bearer ${process.env.FIRECRAWL_API_KEY!}`
  - `Content-Type: application/json`
- **Body:** `{ url: body.url, formats: ["markdown"] }`
- **Response handling:**
  - Parse JSON.
  - If `!res.ok || !json.success`, return a 502 with shape:
    ```json
    { "error": "Firecrawl request failed", "status": <upstream-status>, "message": <json.error or truncated body> }
    ```
  - On success, pass `json.data.markdown` into `summarizeMarkdown(...)`. The downstream `db.insert(knowledge_source).values({...})` block stays exactly as-is.

The buggy `if (!res.text)` check is replaced naturally by `!res.ok || !json.success`.

The outer `try/catch` and `console.error("Error in knowledge store:", error)` log line stay — this matches the project convention noted in `CLAUDE.md` ("routes catch errors and return generic 500s while `console.error`-ing the real cause").

### Firecrawl v2 response shapes (reference)

Success:
```json
{ "success": true, "data": { "markdown": "...", "metadata": { ... } } }
```

Failure (non-2xx or `success: false`):
```json
{ "success": false, "error": "..." }
```

### Cleanup

- **`.env`** — remove `ZENROWS_API_KEY=...`. (User will do this; flagged in the implementation plan.)
- **`CLAUDE.md`** — in the "Required environment" section: remove the `ZENROWS_API_KEY` line; add a `FIRECRAWL_API_KEY` line pointing to `app/api/knowledge/store/route.ts`.
- **`README.md`** — replace the ZenRows mention with Firecrawl.
- **`package.json`** — no changes (no new dependency).
- **`db/schema.ts`** — no changes.

## Testing

The repo has no automated test runner. Verification is manual:

1. `npm run dev`, sign in, add a website knowledge source from the dashboard.
2. Confirm a row lands in `knowledge_source` with `type='website'` and non-empty `content`.
3. Try a malformed/known-bad URL and confirm the response is a 502 with a useful `message`, not a silent success.

## Risks

- **API surface drift** — the Firecrawl v2 endpoint shape (`data.markdown`, `success` flag) is what we're relying on; if Firecrawl changes it, this single call breaks. Acceptable: it's one fetch in one route.
- **Rate limits / pricing** — different limits and pricing model than ZenRows. Out of scope for the swap itself.
