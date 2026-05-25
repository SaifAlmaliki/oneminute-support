# Redis RAG Cache Design

## Goal

Reduce user-visible latency in the RAG chat flow by adding Redis as an optional cache layer. Keep Postgres, pgvector, full-text search, RRF, and Cohere reranking as the source-of-truth retrieval path.

## Current State

- Ingestion writes `knowledge_source` rows plus chunk rows in `knowledge_chunk`.
- Chunk embeddings use OpenAI `text-embedding-3-small` with 1536 dimensions.
- Text chat calls `retrieveContext` from `/api/chat/public`, then generates a short cited answer with GPT-4o.
- Voice calls `/api/widget/knowledge-search`, which returns formatted retrieved context for ElevenLabs to use.
- Retrieval currently combines pgvector HNSW search and Postgres full-text search, fuses candidates with RRF, then reranks with Cohere `rerank-v3.5`.

## Redis Role

Redis is a best-effort acceleration layer, not the canonical knowledge store.

- Use Redis Cloud or Redis Stack with RediSearch and vector index support.
- Add `REDIS_URL` as the required Redis connection setting when cache is enabled.
- If Redis is unavailable, misconfigured, or missing vector index support, fail open and use the existing Postgres RAG flow.
- Do not migrate chunk storage out of Postgres in this phase.

## Cache Scope

Cache entries are shared across visitors only when they have the same tenant and knowledge scope.

The scope key should include:

- `ownerEmail`
- sorted `source_ids`
- a knowledge-scope version/hash derived from the selected `knowledge_source` rows: sorted `id`, `last_updated`, `extraction_status`, and `chunk_count`

Do not scope final-answer cache by `sessionId`; the point is to reuse repeated standalone support questions across visitors for the same business and selected knowledge sources.

## Text Chat Final-Answer Cache

`/api/chat/public` gets a semantic final-answer cache for standalone questions.

Flow:

1. Verify the widget JWT and extract `ownerEmail`, `widgetId`, and `sessionId` as it does today.
2. Parse the latest user message and selected `knowledge_source_ids`.
3. Decide whether the latest message is cacheable.
4. Embed the latest user question with the existing OpenAI embedding path.
5. Search Redis for near-duplicate cached questions under the same cache scope.
6. If a very strict similarity threshold passes, return the cached answer immediately and still persist the user/assistant messages to Postgres for conversation history.
7. On miss, run the existing Postgres RAG and GPT answer generation unchanged.
8. Cache the final answer only after a successful generated response.

Cacheable text questions must be standalone and safe to share across visitors in the same owner/source scope. Skip final-answer caching when:

- the message appears to depend on prior context, such as pronouns or short follow-ups like `what about shipping?`
- the message or generated answer contains likely sensitive/account-specific data such as email addresses, phone numbers, order IDs, ticket IDs, access tokens, or payment details
- the generated answer has no citations when citations are expected
- retrieval returned no chunks
- the answer triggers escalation or asks to create a support ticket

## Voice Context Cache

`/api/widget/knowledge-search` should cache retrieved formatted context, not final answers.

Flow:

1. Verify the voice token and extract `ownerEmail`, `sourceIds`, and `sectionId`.
2. Embed the voice query.
3. Search Redis for near-duplicate cached context under the same owner/source freshness scope.
4. On hit, return cached formatted context.
5. On miss, call `retrieveContext`, format chunks with `formatChunkForPrompt`, return the result, and cache it with the same TTL.

This avoids interfering with ElevenLabs answer generation while still saving the expensive retrieval path for repeated voice queries.

## Redis Data Model

Use Redis JSON documents with RediSearch vector indexes. The docs support JSON documents directly, and JSON is easier to inspect during rollout than binary-heavy hashes.

Recommended logical indexes:

- `idx:rag_answer_cache` for text final-answer cache documents
- `idx:rag_context_cache` for voice retrieved-context cache documents

Text answer cache document fields:

- `id`
- `ownerEmail`
- `scopeHash`
- `sourceIds`
- `question`
- `questionEmbedding`
- `answer`
- `citations` or retrieved chunk metadata needed to validate cited answers
- `createdAt`
- `expiresAt`

Voice context cache document fields:

- `id`
- `ownerEmail`
- `scopeHash`
- `sourceIds`
- `query`
- `queryEmbedding`
- `formattedContext`
- `chunkMetadata`
- `createdAt`
- `expiresAt`

Indexes should include tag/text fields for tenant and scope filters, plus a `VECTOR` field using `TYPE FLOAT32`, `DIM 1536`, and cosine distance to match OpenAI `text-embedding-3-small`.

## Freshness And Invalidation

Use both immediate invalidation by scope version and a TTL.

- Default TTL: 24 hours.
- Include the source freshness signal in `scopeHash`; when selected source content changes, new requests stop matching older entries.
- Best-effort deletion can remove old entries for an owner/source when knowledge is updated, but correctness should not depend on deletion succeeding.

## Hit Strictness

Use a very strict semantic threshold for final-answer cache hits. Redis cosine distance is lower when vectors are more similar, so only low-distance near-duplicate intent is accepted.

Initial behavior:

- final-answer cache: initial maximum cosine distance `0.08`, intended for near duplicates only
- voice context cache: initial maximum cosine distance `0.12`, because the final response is still generated by ElevenLabs
- log candidate scores so thresholds can be tuned from real traffic

## Observability

Use structured logs in the first version.

Log at least:

- cache type: `answer` or `context`
- result: `hit`, `miss`, `skip`, or `error`
- skip reason for non-cacheable requests
- owner/scope hash, not raw tenant secrets
- similarity/distance score for top candidate
- elapsed time for Redis lookup and fallback retrieval path
- Redis setup/index errors

Do not add an admin stats API in the first phase.

## Error Handling

Redis must fail open.

- Connection failures should not block chat responses.
- Index creation failures should be logged and should disable cache usage for that request.
- Cache read/write failures should be logged and ignored.
- Existing Postgres RAG remains the fallback path.

## Testing And Verification

Focused checks for implementation:

- TypeScript: `npx tsc --noEmit`.
- Unit-level tests or script checks for cache-key/scope hashing, cacheability filtering, and embedding-to-FLOAT32 buffer conversion if a test harness is added.
- Manual Redis verification with a local Redis Stack or Redis Cloud instance: index creation, cache miss, cache write, cache hit, and fail-open behavior with Redis disabled.
- Regression check that `/api/chat/public` still persists messages on cache hits and misses.
- Regression check that `/api/widget/knowledge-search` returns identical formatted context shape on cache hits and misses.

## Out Of Scope

- Replacing pgvector with Redis as the primary vector store.
- Migrating existing chunks into Redis as canonical documents.
- Admin UI for cache statistics or manual cache clearing.
- Long-term conversation memory in Redis.
- Caching user-specific/account-specific answers across visitors.
