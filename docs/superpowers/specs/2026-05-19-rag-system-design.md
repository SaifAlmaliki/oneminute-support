# RAG System Redesign — Design Spec

**Date:** 2026-05-19
**Status:** Approved — pending implementation plan
**Replaces:** Existing summarize-then-store knowledge ingestion + retrieve-everything chat path

---

## Problem

The current knowledge pipeline destroys facts at ingest time and stuffs every selected source into the chat context at retrieval time:

- `/api/knowledge/store` summarizes uploaded CSVs, PDFs, and websites into a single ≤2000-word paragraph stored in `knowledge_source.content` (`lib/openAI.ts` `summarizeMarkdown`). Specific values, SKUs, dates, and row data are lost.
- `/api/chat/public` concatenates the `content` blob of every selected source for every query — no relevance scoring, no chunking, no embeddings. Token usage scales linearly with knowledge base size and answer quality is bound by the upstream summary.

Companies cannot rely on this as a source of truth. The fix is a real RAG pipeline: chunked storage, hybrid retrieval, reranking, and citations — built natively on the existing Neon Postgres + Vercel + OpenAI stack with `pgvector`.

This is a **greenfield rewrite**. There are no production users to preserve; the old summarize-on-ingest path is deleted in full.

---

## Decisions Locked

| # | Decision | Rationale |
|---|---|---|
| 1 | **pgvector on Neon** for vector storage | One database, no new vendor, native Neon support, scales to millions of vectors per tenant |
| 2 | **Hybrid retrieval (vector + Postgres FTS) + Cohere `rerank-v3.5`** | Catches both semantic matches and exact-keyword matches (SKUs, IDs, names); reranker pushes the system into source-of-truth territory |
| 3 | **Row-as-chunk + per-file summary chunk** for CSVs | Each row independently retrievable; summary chunk handles "what's in this dataset?" questions; no text-to-SQL complexity |
| 4 | **Vercel Blob** for original-file storage | Native to hosting, cheap (~$0.15/GB/mo); enables future re-chunking without user re-upload |
| 5 | **Cascade FK** from `knowledge_chunk.source_id` → `knowledge_source.id` | Deliberately breaks the codebase's "no FKs" convention here — orphaned chunks would cause silent retrieval bugs and storage bloat |
| 6 | **`text-embedding-3-small` (1536 dim)** | Price/quality sweet spot; works with standard `vector` type and standard HNSW index, no `halfvec`/Matryoshka complexity |

---

## Architecture

### High-level flow

```
[Dashboard upload] → POST /api/knowledge/store
                ├─ store original bytes → Vercel Blob
                ├─ extract text (PDF: pdfjs-dist; CSV: csv-parse; Website: Firecrawl)
                ├─ chunk (prose: recursive 800/120; CSV: row-as-chunk + 1 summary chunk)
                ├─ embed batched → text-embedding-3-small (1536-dim)
                └─ insert knowledge_source (1 row) + knowledge_chunk (N rows)

[Embed widget] → POST /api/chat/public
                ├─ embed user query → text-embedding-3-small
                ├─ pgvector cosine top-20 (filtered by source_ids + user_email)
                ├─ Postgres FTS top-20 (same filter, run in parallel)
                ├─ merge via Reciprocal Rank Fusion → top-20 candidates
                ├─ Cohere rerank → top-5 (drop below 0.05 score)
                ├─ build context block with [N] Source: ... citations
                └─ generate completion as today (gpt-4o, max_tokens=200)
```

### New module layout

```
lib/rag/
  ingest.ts      # orchestrator: blob → extract → chunk → embed → insert
  extract.ts     # pdf, csv, website extractors → normalized text + metadata
  chunk.ts       # recursiveSplit() for prose, rowChunks() for csv
  embed.ts       # batched OpenAI embeddings (100/batch)
  retrieve.ts    # called by /api/chat/public — replaces context-fetch block
  rerank.ts      # Cohere wrapper with fallback
```

`/api/knowledge/store` becomes a thin orchestrator; real work lives in `lib/rag/`.

---

## Database Schema

### Enable pgvector (one-time migration)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### `knowledge_source` (modified)

Existing columns stay. Changes:

```ts
// REMOVED:
// content: text("content"),

// ADDED:
blob_url: text("blob_url"),
blob_pathname: text("blob_pathname"),
extraction_status: text("extraction_status").notNull().default("pending"),
                                          // pending | extracting | embedding | ready | failed
extraction_error: text("extraction_error"),
chunk_count: text("chunk_count"),         // populated when status = 'ready'
```

`source_url`, `meta_data`, `name`, `type`, `user_email`, `status`, timestamps all stay as-is.

### `knowledge_chunk` (new)

```ts
export const knowledge_chunk = pgTable("knowledge_chunk", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  source_id: text("source_id")
    .notNull()
    .references(() => knowledge_source.id, { onDelete: "cascade" }),
  user_email: text("user_email").notNull(),     // denormalized for tenant filter
  chunk_index: text("chunk_index").notNull(),   // "0","1",... preserves order
  chunk_type: text("chunk_type").notNull(),     // "prose" | "csv_row" | "csv_summary"
  content: text("content").notNull(),           // raw text — used for FTS + sent to LLM
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  meta_data: text("meta_data"),                 // JSON: page_number | csv_row_index | headers
  created_at: text("created_at").default(sql`now()`),
});
```

The `fts` column is added via raw SQL (Drizzle has no first-class `tsvector` modeling):

```sql
ALTER TABLE knowledge_chunk
  ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
```

### Indexes

```sql
-- Vector search (HNSW: better recall than IVFFlat, no retraining as data grows)
CREATE INDEX knowledge_chunk_embedding_idx
  ON knowledge_chunk USING hnsw (embedding vector_cosine_ops);

-- Full-text search
CREATE INDEX knowledge_chunk_fts_idx
  ON knowledge_chunk USING gin (fts);

-- Filter pre-narrowing
CREATE INDEX knowledge_chunk_source_idx ON knowledge_chunk (source_id);
CREATE INDEX knowledge_chunk_user_idx   ON knowledge_chunk (user_email);
```

### Cascade behavior

`onDelete: "cascade"` means `DELETE FROM knowledge_source WHERE id = ?` automatically removes all matching `knowledge_chunk` rows in the same transaction. The dashboard's delete-source handler stays a one-liner.

External cleanup (not cascadable): the original file in Vercel Blob must be deleted separately via `del(blob_pathname)`. Order: **DB delete first, then blob delete.** A blob-delete failure leaves an orphan file (recoverable via periodic sweep) rather than the reverse, where chunks would outlive the source.

---

## Ingestion Pipeline

### Steps

1. **Persist original.** Upload bytes (or fetched website markdown) to Vercel Blob → `{ url, pathname }`.
2. **Insert `knowledge_source` row** with `extraction_status = 'pending'`. The full pipeline runs synchronously inside the request (`maxDuration = 300` is already set in `/api/knowledge/store`); the client receives the source row only after extraction completes with `status = 'ready'` or `status = 'failed'`. The `pending` state exists for the brief window during processing and as a safety net if the function is ever killed mid-run.
3. **Extract text** based on type:
   - **PDF** — reuse `extractPdfText()` from `lib/pdf/extractPdf.ts`. Track page boundaries; each chunk inherits `page_number`.
   - **CSV** — parse with `csv-parse/sync` (handles quoted commas; small dep). Output: `{ rowIndex, headers, values }[]`.
   - **Website** — already-fetched markdown from Firecrawl; pass through.
4. **Chunk:**
   - **Prose:** `RecursiveCharacterTextSplitter` from `@langchain/textsplitters`. **800 tokens / 120 overlap.** Separators `["\n\n", "\n", ". ", " ", ""]`. Token-aware via `js-tiktoken` (already in deps).
   - **CSV row-as-chunk:** each row formatted `"<header1>: <value1> | <header2>: <value2> | ..."`. Rows under 50 chars get coalesced with neighbors. Metadata: `{ csv_row_index, headers }`.
   - **CSV summary chunk:** one extra chunk per file: `"This dataset is named <filename>. It has <N> rows and columns: <header list>. Sample rows: <first 3 rows truncated>."` Metadata: `{ chunk_type: "csv_summary" }`.
5. **Embed in batches.** `text-embedding-3-small`, batches of 100. Cost ~$0.02 per 1M tokens.
6. **Insert chunks.** Single `db.insert(knowledge_chunk).values([...])`. Update `knowledge_source` to `extraction_status = 'ready'`, `chunk_count = N`.
7. **Failure handling.** Any step throws → `extraction_status = 'failed'`, `extraction_error = <message>`. Blob is kept (cheap; lets users retry). Existing PDF errors (`PdfEncryptedError`, `PdfTooLargeError`, `PdfImageOnlyError`, `PdfCorruptError`) continue to surface to the UI as today.

### Limits

| Limit | Value | Why |
|---|---|---|
| Max chunks per source | 2,000 | A 30-page PDF is roughly 30–60 chunks at 800 tokens/120 overlap; only an oversized CSV realistically hits this. CSVs over 2k rows return "split your file" — matches existing PDF page-limit pattern. |
| Hard cap on embedding tokens per upload | ~1M | Sanity check against runaway extraction bugs (~$0.02 ceiling on the small model). |

### Removed code

- `summarizeMarkdown` in `lib/openAI.ts` — deleted.
- The `if (length > 500)` / `if (length > 8000)` summarize gates in `/api/knowledge/store` — deleted.
- `knowledge_source.content` writes — deleted (column dropped).

`summarizeConversation` stays (used by the rolling 6k-token chat compaction; separate concern).

---

## Retrieval Pipeline

### `lib/rag/retrieve.ts`

```ts
retrieveContext({
  query: string,
  sourceIds: string[],
  userEmail: string,        // tenant guard
  topK?: number = 5,
}): Promise<RetrievedChunk[]>

type RetrievedChunk = {
  content: string;
  sourceName: string;       // e.g., "product-faq.pdf"
  sourceId: string;
  chunkIndex: number;
  chunkType: "prose" | "csv_row" | "csv_summary";
  pageNumber?: number;      // PDFs only
  csvRowIndex?: number;     // CSVs only
  rerankScore: number;
}
```

### Stages

1. **Embed query.** `text-embedding-3-small`. ~50ms, ~$0.000002.
2. **Vector search — top 20** (in parallel with stage 3):
   ```sql
   SELECT id, source_id, content, chunk_type, meta_data,
          1 - (embedding <=> $queryVec) AS score
   FROM knowledge_chunk
   WHERE source_id = ANY($sourceIds) AND user_email = $userEmail
   ORDER BY embedding <=> $queryVec
   LIMIT 20;
   ```
3. **Full-text search — top 20** (in parallel with stage 2):
   ```sql
   SELECT id, source_id, content, chunk_type, meta_data,
          ts_rank(fts, plainto_tsquery('english', $query)) AS score
   FROM knowledge_chunk
   WHERE source_id = ANY($sourceIds) AND user_email = $userEmail
     AND fts @@ plainto_tsquery('english', $query)
   ORDER BY score DESC
   LIMIT 20;
   ```
4. **Reciprocal Rank Fusion (RRF) — merge to top 20.** Per chunk: `RRF_score = Σ 1 / (60 + rank_in_list)`. The `60` is the standard RRF constant; no tuning needed. Score-free, list-rank-only — works across the cosine-vs-ts_rank scale mismatch.
5. **Cohere rerank — final top 5:**
   ```ts
   cohere.rerank({
     model: "rerank-v3.5",
     query,
     documents: candidates.map(c => c.content),
     topN: 5,
   })
   ```
   ~150–250ms latency, ~$0.002 per query.

### Drop low-confidence results

If the top reranker score is **below 0.05** (Cohere's recommended floor for "almost certainly irrelevant"), `retrieveContext` returns `[]`. The chat route then knows the KB has no answer and the system prompt's empty-context branch fires (escalation protocol). This is the **source-of-truth behavior** — today's pipeline would hallucinate.

### Reranker fallback

Cohere is a single point of failure for chat. Catch rerank errors, log, and **fall back to top-5 by RRF score**. One try/catch, one log line. Quality dips but the bot stays online.

### Tenant safety

Every query has `WHERE user_email = $userEmail` even though `sourceIds` already implies it. Defense in depth — if a future bug ever leaks a foreign source ID into the request, the row is still filtered out at the DB layer.

---

## Chat Integration

### `/api/chat/public` changes

The route shrinks. Auth, JWT verification, conversation persistence, and the 6k-token rolling summary all stay identical. Only the context-building block changes.

**Before:**
```ts
const sources = await db.select(...).from(knowledge_source)
  .where(inArray(knowledge_source.id, knowledge_source_ids));
context = sources.map(s => s.content).filter(Boolean).join("\n\n");
```

**After:**
```ts
// ownerEmail is already in the widget JWT (signed by /api/widget/session).
// Just extract it alongside sessionId/widgetId from the existing jwtVerify call.
const ownerEmail = payload.ownerEmail as string;

const chunks = await retrieveContext({
  query: lastMessage.content,
  sourceIds: knowledge_source_ids,
  userEmail: ownerEmail,
  topK: 5,
});

context = chunks.length === 0
  ? ""
  : chunks.map((c, i) => formatChunkForPrompt(c, i + 1)).join("\n\n");
```

### Citation format

Every chunk is tagged with a numbered header so the model can cite cleanly:

```
[1] Source: product-manual.pdf, page 12
<chunk content>

[2] Source: orders-2024.csv, row 847 (status=shipped, total=$129.50, ...)
<chunk content>
```

CSV row chunks inline key headers in the citation header for the model's benefit.

### System prompt updates

Three targeted additions to the existing Sarah prompt:

**1. Grounding rule** (replaces current "Context:" footer):
```
GROUNDING:
- Answer ONLY using the numbered context blocks below. Each block has format
  "[N] Source: ..." — use it.
- When you state a fact, append the citation in square brackets, e.g., "Returns
  are accepted within 30 days [1]."
- If the context does not contain the answer, say so — never guess, never use
  general knowledge to fill gaps.
```

**2. Empty-context branch** — when `chunks.length === 0`, swap in:
```
IMPORTANT: No relevant information was found in the knowledge base for this
question. Acknowledge that you don't have information on this topic, then offer
to create a support ticket.
```

**3. Brevity rule and escalation protocol stay unchanged.**

`max_tokens: 200` stays — citations cost ~1 token per fact and fit easily.

### Token cost reduction

Today: 50-source KB → ~50 × ~2000-word summaries ≈ 150k tokens of context (silently truncated by gpt-4o).
After: ≤5 chunks × ~800 tokens ≈ 4k tokens of context regardless of KB size.

---

## Operational Concerns

### Environment variables to add

```
COHERE_API_KEY=...                     # rerank-v3.5
BLOB_READ_WRITE_TOKEN=...              # auto-injected by Vercel when Blob is enabled
```

`OPENAI_API_KEY` is reused for embeddings via the existing `lib/openAI.ts` client. The dev-only `rejectUnauthorized: false` in that file is preserved as a separate concern, not in scope here.

### Vercel function limits

- Ingest route: `maxDuration = 300` already set. 30-page PDF ≈ 5–8s; 2k-row CSV ≈ 10–15s.
- Chat route: full retrieve+rerank+generate path ≈ 1.5s.

### Cost model

| Operation | Cost |
|---|---|
| Ingest a 30-page PDF | <$0.01 |
| Ingest a 2k-row CSV | ~$0.04 |
| Per chat query — query embed | $0.000002 |
| Per chat query — rerank | $0.002 |
| Per chat query — gpt-4o (4k context, 200 out) | ~$0.005 |
| **Per chat query total** | **~$0.007** |
| Vercel Blob storage | $0.15/GB/mo |

Rerank is ~30% of per-query cost. If cost ever needs to be cut, the rerank fallback path already exists for free.

### Observability — `console.log` at three points

1. **Ingest completion:** `{ source_id, chunk_count, extraction_ms, embed_ms }` — spots pathological files.
2. **Retrieve completion:** `{ query_len, vector_hits, fts_hits, rrf_candidates, top_rerank_score, returned }` — diagnoses "why did the bot say it didn't know".
3. **Empty-context decisions:** `{ widget_id, query, top_rerank_score }` — most important signal for "is the KB missing coverage?"

Matches existing convention. No logger added.

### Risks

| Risk | Mitigation |
|---|---|
| Cohere outage breaks chat | Try/catch the rerank step; fall back to top-5 by RRF score |
| Embedding model lock-in (`-small`, 1536 dim) | Originals in Blob; re-embedding any time is mechanical |
| HNSW build time on first big load | Not an issue at current scale; flag for later |

---

## Rollout Plan

Greenfield — no back-compat to preserve. Phases are sequential commits.

| Phase | Work | Verification |
|---|---|---|
| 1 | **Schema & deps.** Migration: enable pgvector, create `knowledge_chunk`, alter `knowledge_source` (drop `content`, add new fields, cascade FK). Add `cohere-ai`, `@vercel/blob`, `@langchain/textsplitters`, `csv-parse` to deps. | Migration applies clean against fresh DB; types compile. |
| 2 | **`lib/rag/`.** Build extract / chunk / embed / retrieve / rerank as pure functions. | Each callable from a one-off `tsx` script with sample PDFs and CSVs. |
| 3 | **Wire ingest route.** Replace summarize-and-store path with the new pipeline. | Upload a real PDF and CSV via the dashboard; verify chunks land in DB with correct types and metadata. |
| 4 | **Wire chat route.** Replace context-building block with `retrieveContext()`. Add empty-context system-prompt branch. | End-to-end widget chat with citations; test "off-topic" question to verify empty-context escalation fires. |
| 5 | **Delete dead code.** Remove `summarizeMarkdown` and the summarize-on-ingest gates. | Build clean; no orphan references. |

---

## Out of Scope

Explicitly deferred so the plan doesn't grow:

- Streaming chat responses (currently single JSON `{ response }`)
- Re-chunking job to migrate to a new embedding model later
- OCR for image-only PDFs (`PdfImageOnlyError` still surfaces as today)
- Text-to-SQL for CSV aggregate queries (decided against)
- Reranker quality dashboards / eval harness
- Per-customer embedding model choice
- Production hardening of `rejectUnauthorized: false` in `lib/openAI.ts`
- Content-hash deduplication for repeat uploads
