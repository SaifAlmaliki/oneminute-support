# Redis RAG Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Redis as an optional semantic cache layer that reduces RAG latency while keeping Postgres/pgvector as the source of truth.

**Architecture:** Add focused cache utilities under `lib/rag/cache/**`, backed by Redis JSON + RediSearch vector indexes when `REDIS_URL` is configured. `/api/chat/public` uses a strict final-answer cache for standalone safe text questions; `/api/widget/knowledge-search` uses a strict retrieved-context cache for voice. All Redis failures fail open to the current Postgres RAG flow.

**Tech Stack:** Next.js route handlers, TypeScript, Drizzle/Neon Postgres, OpenAI embeddings, Redis Stack/Cloud with RediSearch vector indexes, `redis` npm client, `tsx` verification scripts.

**Commit Policy:** Do not commit during this work unless the user explicitly asks. The user requested no commits.

---

## File Structure

- Create `lib/rag/cache/types.ts`: shared cache result and document types.
- Create `lib/rag/cache/utils.ts`: pure helpers for source scope hashing, vector serialization, cacheability filters, citation checks, and log-safe hashing.
- Create `scripts/verify-rag-cache-utils.ts`: executable assertions for pure helpers using `node:assert/strict`.
- Create `lib/redis/client.ts`: lazy Redis client creation, connection reuse, and fail-open unavailable state.
- Create `lib/rag/cache/redis.ts`: Redis index creation, vector search, JSON writes, TTL handling, and typed answer/context cache operations.
- Create `lib/rag/cache/scope.ts`: database-backed source freshness lookup for `scopeHash`.
- Create `lib/rag/cache/answer.ts`: final-answer cache orchestration for text chat.
- Create `lib/rag/cache/context.ts`: retrieved-context cache orchestration for voice knowledge search.
- Modify `app/api/chat/public/route.ts`: check answer cache before RAG/LLM and write cache after successful generation.
- Modify `app/api/widget/knowledge-search/route.ts`: check context cache before `retrieveContext` and write cache after retrieval.
- Modify `package.json` and `package-lock.json`: add `redis` dependency via npm.
- Modify `.env.example` only if it exists. If it does not exist, do not create one in this task.

---

### Task 1: Add Pure Cache Utilities And Verification Script

**Files:**
- Create: `lib/rag/cache/types.ts`
- Create: `lib/rag/cache/utils.ts`
- Create: `scripts/verify-rag-cache-utils.ts`

- [ ] **Step 1: Create shared cache types**

Create `lib/rag/cache/types.ts`:

```ts
import type { RetrievedChunk } from "@/lib/rag/types";

export type RagCacheKind = "answer" | "context";

export type RagCacheLookupResult<T> =
  | { status: "hit"; value: T; distance: number; cacheId: string }
  | { status: "miss"; distance?: number }
  | { status: "skip"; reason: string }
  | { status: "error"; error: unknown };

export type SourceFreshness = {
  id: string;
  lastUpdated: string | null;
  extractionStatus: string;
  chunkCount: string | null;
};

export type AnswerCacheValue = {
  answer: string;
  citations: RetrievedChunk[];
};

export type ContextCacheValue = {
  formattedContext: string;
  chunks: RetrievedChunk[];
};

export type AnswerCacheDocument = {
  id: string;
  ownerEmail: string;
  scopeHash: string;
  sourceIds: string[];
  question: string;
  questionEmbedding: number[];
  answer: string;
  citations: RetrievedChunk[];
  createdAt: string;
  expiresAt: string;
};

export type ContextCacheDocument = {
  id: string;
  ownerEmail: string;
  scopeHash: string;
  sourceIds: string[];
  query: string;
  queryEmbedding: number[];
  formattedContext: string;
  chunks: RetrievedChunk[];
  createdAt: string;
  expiresAt: string;
};
```

- [ ] **Step 2: Create pure utility helpers**

Create `lib/rag/cache/utils.ts`:

```ts
import crypto from "node:crypto";
import type { RetrievedChunk } from "@/lib/rag/types";
import type { SourceFreshness } from "./types";

const SENSITIVE_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\+?\d[\d\s().-]{7,}\d/,
  /\b(?:order|ticket|case|invoice|payment|account)\s*#?:?\s*[A-Z0-9-]{4,}\b/i,
  /\b(?:sk|pk|tok|key|secret)_[A-Za-z0-9_-]{12,}\b/,
];

const FOLLOW_UP_PATTERNS = [
  /^\s*(it|that|this|they|them|those|he|she|what about|how about|and|also)\b/i,
  /^\s*(yes|no|ok|okay|sure|why|how so)\??\s*$/i,
];

export function sortedSourceIds(sourceIds: string[]): string[] {
  return [...new Set(sourceIds)].sort();
}

export function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildScopeHash(params: {
  ownerEmail: string;
  sourceIds: string[];
  sources: SourceFreshness[];
}): string {
  const sourceFreshness = [...params.sources]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((source) => ({
      id: source.id,
      lastUpdated: source.lastUpdated ?? "",
      extractionStatus: source.extractionStatus,
      chunkCount: source.chunkCount ?? "",
    }));

  return stableHash({
    ownerEmail: params.ownerEmail,
    sourceIds: sortedSourceIds(params.sourceIds),
    sourceFreshness,
  });
}

export function hasSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isLikelyStandaloneQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  return !FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function answerHasCitation(answer: string): boolean {
  return /\[\d+\]/.test(answer);
}

export function shouldSkipAnswerCache(params: {
  question: string;
  answer?: string;
  chunks?: RetrievedChunk[];
}): string | null {
  if (!isLikelyStandaloneQuestion(params.question)) return "not_standalone";
  if (hasSensitiveContent(params.question)) return "sensitive_question";
  if (params.answer && hasSensitiveContent(params.answer)) return "sensitive_answer";
  if (params.answer && !answerHasCitation(params.answer)) return "missing_citation";
  if (params.chunks && params.chunks.length === 0) return "no_chunks";
  if (params.answer && /\[ESCALATED\]|support ticket/i.test(params.answer)) return "escalation";
  return null;
}

export function float32Buffer(values: number[]): Buffer {
  const array = new Float32Array(values);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

export function cacheLogFields(params: {
  kind: "answer" | "context";
  result: "hit" | "miss" | "skip" | "error";
  ownerEmail: string;
  scopeHash: string;
  distance?: number;
  reason?: string;
  elapsedMs?: number;
}) {
  return {
    cache: params.kind,
    result: params.result,
    ownerHash: stableHash(params.ownerEmail).slice(0, 12),
    scopeHash: params.scopeHash.slice(0, 12),
    distance: params.distance,
    reason: params.reason,
    elapsedMs: params.elapsedMs,
  };
}
```

- [ ] **Step 3: Add a verification script for pure helpers**

Create `scripts/verify-rag-cache-utils.ts`:

```ts
import assert from "node:assert/strict";
import {
  answerHasCitation,
  buildScopeHash,
  cacheLogFields,
  float32Buffer,
  hasSensitiveContent,
  isLikelyStandaloneQuestion,
  shouldSkipAnswerCache,
  sortedSourceIds,
} from "../lib/rag/cache/utils";

const sources = [
  { id: "b", lastUpdated: "2026-01-02", extractionStatus: "ready", chunkCount: "2" },
  { id: "a", lastUpdated: "2026-01-01", extractionStatus: "ready", chunkCount: "1" },
];

assert.deepEqual(sortedSourceIds(["b", "a", "a"]), ["a", "b"]);

assert.equal(
  buildScopeHash({ ownerEmail: "owner@example.com", sourceIds: ["b", "a"], sources }),
  buildScopeHash({ ownerEmail: "owner@example.com", sourceIds: ["a", "b"], sources: [...sources].reverse() })
);

assert.notEqual(
  buildScopeHash({ ownerEmail: "owner@example.com", sourceIds: ["a", "b"], sources }),
  buildScopeHash({
    ownerEmail: "owner@example.com",
    sourceIds: ["a", "b"],
    sources: [{ ...sources[0], chunkCount: "3" }, sources[1]],
  })
);

assert.equal(hasSensitiveContent("email me at user@example.com"), true);
assert.equal(hasSensitiveContent("what is your return policy"), false);
assert.equal(isLikelyStandaloneQuestion("What is your return policy?"), true);
assert.equal(isLikelyStandaloneQuestion("What about that?"), false);
assert.equal(answerHasCitation("Returns are accepted within 30 days [1]."), true);
assert.equal(answerHasCitation("Returns are accepted within 30 days."), false);
assert.equal(shouldSkipAnswerCache({ question: "What about that?" }), "not_standalone");
assert.equal(
  shouldSkipAnswerCache({
    question: "What is your return policy?",
    answer: "Returns are accepted within 30 days [1].",
    chunks: [
      {
        content: "Returns are accepted within 30 days.",
        sourceName: "Policy",
        sourceId: "source-1",
        chunkIndex: 0,
        chunkType: "prose",
        rerankScore: 0.9,
      },
    ],
  }),
  null
);

const vector = float32Buffer([1, 2, 3]);
assert.equal(vector.byteLength, 12);

const logFields = cacheLogFields({
  kind: "answer",
  result: "hit",
  ownerEmail: "owner@example.com",
  scopeHash: "1234567890abcdef",
  distance: 0.03,
});
assert.equal(logFields.ownerHash.length, 12);
assert.equal(logFields.scopeHash, "1234567890ab");

console.log("rag cache utility checks passed");
```

- [ ] **Step 4: Run the utility verification script and confirm it passes**

Run: `npx tsx scripts/verify-rag-cache-utils.ts`

Expected: output contains `rag cache utility checks passed` and exits `0`.

---

### Task 2: Add Redis Dependency, Client, And Cache Index Layer

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/redis/client.ts`
- Create: `lib/rag/cache/redis.ts`

- [ ] **Step 1: Install the Redis client**

Run: `npm install redis`

Expected: `package.json` and `package-lock.json` include `redis`.

- [ ] **Step 2: Create the lazy Redis client**

Create `lib/redis/client.ts`:

```ts
import { createClient, type RedisClientType } from "redis";

let clientPromise: Promise<RedisClientType> | null = null;

export function isRedisCacheConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

export async function getRedisClient(): Promise<RedisClientType | null> {
  if (!process.env.REDIS_URL) return null;

  if (!clientPromise) {
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (error) => {
      console.error("[rag-cache] redis client error", error);
    });
    clientPromise = client.connect().then(() => client as RedisClientType);
  }

  try {
    return await clientPromise;
  } catch (error) {
    console.error("[rag-cache] redis connect failed", error);
    clientPromise = null;
    return null;
  }
}
```

- [ ] **Step 3: Create Redis index and JSON operations**

Create `lib/rag/cache/redis.ts`:

```ts
import { getRedisClient } from "@/lib/redis/client";
import { float32Buffer } from "./utils";
import type {
  AnswerCacheDocument,
  AnswerCacheValue,
  ContextCacheDocument,
  ContextCacheValue,
  RagCacheLookupResult,
} from "./types";

const VECTOR_DIMENSIONS = 1536;
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const ANSWER_INDEX = "idx:rag_answer_cache";
const CONTEXT_INDEX = "idx:rag_context_cache";
const ANSWER_PREFIX = "rag:answer:";
const CONTEXT_PREFIX = "rag:context:";
const ANSWER_MAX_DISTANCE = 0.08;
const CONTEXT_MAX_DISTANCE = 0.12;

let indexesReady: Promise<boolean> | null = null;

export async function ensureRagCacheIndexes(): Promise<boolean> {
  if (indexesReady) return indexesReady;
  indexesReady = createIndexes();
  return indexesReady;
}

async function createIndexes(): Promise<boolean> {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    await createIndexIfMissing(client, ANSWER_INDEX, ANSWER_PREFIX, "$.questionEmbedding");
    await createIndexIfMissing(client, CONTEXT_INDEX, CONTEXT_PREFIX, "$.queryEmbedding");
    return true;
  } catch (error) {
    console.error("[rag-cache] index setup failed", error);
    indexesReady = null;
    return false;
  }
}

async function createIndexIfMissing(
  client: NonNullable<Awaited<ReturnType<typeof getRedisClient>>>,
  indexName: string,
  prefix: string,
  vectorPath: string
) {
  try {
    await client.sendCommand(["FT.INFO", indexName]);
    return;
  } catch {
    await client.sendCommand([
      "FT.CREATE",
      indexName,
      "ON",
      "JSON",
      "PREFIX",
      "1",
      prefix,
      "SCHEMA",
      "$.ownerEmail",
      "AS",
      "ownerEmail",
      "TAG",
      "$.scopeHash",
      "AS",
      "scopeHash",
      "TAG",
      vectorPath,
      "AS",
      "vector",
      "VECTOR",
      "FLAT",
      "6",
      "TYPE",
      "FLOAT32",
      "DIM",
      String(VECTOR_DIMENSIONS),
      "DISTANCE_METRIC",
      "COSINE",
    ]);
  }
}

export async function lookupAnswerCache(params: {
  ownerEmail: string;
  scopeHash: string;
  embedding: number[];
}): Promise<RagCacheLookupResult<AnswerCacheValue>> {
  const doc = await searchCache<AnswerCacheDocument>({
    indexName: ANSWER_INDEX,
    ownerEmail: params.ownerEmail,
    scopeHash: params.scopeHash,
    embedding: params.embedding,
    maxDistance: ANSWER_MAX_DISTANCE,
  });

  if (!doc) return { status: "miss" };
  if (doc.distance > ANSWER_MAX_DISTANCE) return { status: "miss", distance: doc.distance };

  return {
    status: "hit",
    cacheId: doc.id,
    distance: doc.distance,
    value: { answer: doc.value.answer, citations: doc.value.citations },
  };
}

export async function lookupContextCache(params: {
  ownerEmail: string;
  scopeHash: string;
  embedding: number[];
}): Promise<RagCacheLookupResult<ContextCacheValue>> {
  const doc = await searchCache<ContextCacheDocument>({
    indexName: CONTEXT_INDEX,
    ownerEmail: params.ownerEmail,
    scopeHash: params.scopeHash,
    embedding: params.embedding,
    maxDistance: CONTEXT_MAX_DISTANCE,
  });

  if (!doc) return { status: "miss" };
  if (doc.distance > CONTEXT_MAX_DISTANCE) return { status: "miss", distance: doc.distance };

  return {
    status: "hit",
    cacheId: doc.id,
    distance: doc.distance,
    value: { formattedContext: doc.value.formattedContext, chunks: doc.value.chunks },
  };
}

async function searchCache<T>(params: {
  indexName: string;
  ownerEmail: string;
  scopeHash: string;
  embedding: number[];
  maxDistance: number;
}): Promise<{ id: string; distance: number; value: T } | null> {
  const client = await getRedisClient();
  if (!client) return null;
  if (!(await ensureRagCacheIndexes())) return null;

  const query = `(@ownerEmail:{${escapeTag(params.ownerEmail)}} @scopeHash:{${escapeTag(params.scopeHash)}})=>[KNN 1 @vector $query_vector AS vector_score]`;
  const response = (await client.sendCommand([
    "FT.SEARCH",
    params.indexName,
    query,
    "PARAMS",
    "2",
    "query_vector",
    float32Buffer(params.embedding),
    "SORTBY",
    "vector_score",
    "RETURN",
    "2",
    "$",
    "vector_score",
    "DIALECT",
    "2",
  ])) as unknown[];

  const total = Number(response[0] ?? 0);
  if (total === 0) return null;

  const id = String(response[1]);
  const fields = response[2] as unknown[];
  const jsonIndex = fields.findIndex((field) => field === "$");
  const scoreIndex = fields.findIndex((field) => field === "vector_score");
  if (jsonIndex === -1 || scoreIndex === -1) return null;

  return {
    id,
    distance: Number(fields[scoreIndex + 1]),
    value: JSON.parse(String(fields[jsonIndex + 1])) as T,
  };
}

export async function writeAnswerCache(doc: AnswerCacheDocument): Promise<void> {
  await writeJson(`${ANSWER_PREFIX}${doc.id}`, doc);
}

export async function writeContextCache(doc: ContextCacheDocument): Promise<void> {
  await writeJson(`${CONTEXT_PREFIX}${doc.id}`, doc);
}

async function writeJson(key: string, doc: AnswerCacheDocument | ContextCacheDocument): Promise<void> {
  const client = await getRedisClient();
  if (!client) return;
  if (!(await ensureRagCacheIndexes())) return;

  await client.sendCommand(["JSON.SET", key, "$", JSON.stringify(doc)]);
  await client.expire(key, CACHE_TTL_SECONDS);
}

function escapeTag(value: string): string {
  return value.replace(/([,{}.\\[\]"'|@\s])/g, "\\$1");
}
```

- [ ] **Step 4: Run TypeScript to catch dependency/API issues**

Run: `npx tsc --noEmit`

Expected: no TypeScript errors from `lib/redis/client.ts` or `lib/rag/cache/redis.ts`. If the `redis` package types differ, adjust `RedisClientType` casting locally while preserving the exported function signatures.

---

### Task 3: Add Database-Backed Scope Hashing

**Files:**
- Create: `lib/rag/cache/scope.ts`
- Modify: `scripts/verify-rag-cache-utils.ts`

- [ ] **Step 1: Create source freshness lookup**

Create `lib/rag/cache/scope.ts`:

```ts
import { db } from "@/db/client";
import { knowledge_source } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { buildScopeHash, sortedSourceIds } from "./utils";
import type { SourceFreshness } from "./types";

export async function buildKnowledgeScope(params: {
  ownerEmail: string;
  sourceIds: string[];
}): Promise<{ sourceIds: string[]; scopeHash: string; sources: SourceFreshness[] }> {
  const sourceIds = sortedSourceIds(params.sourceIds);
  if (sourceIds.length === 0) {
    return {
      sourceIds,
      scopeHash: buildScopeHash({ ownerEmail: params.ownerEmail, sourceIds, sources: [] }),
      sources: [],
    };
  }

  const rows = await db
    .select({
      id: knowledge_source.id,
      lastUpdated: knowledge_source.last_updated,
      extractionStatus: knowledge_source.extraction_status,
      chunkCount: knowledge_source.chunk_count,
    })
    .from(knowledge_source)
    .where(and(eq(knowledge_source.user_email, params.ownerEmail), inArray(knowledge_source.id, sourceIds)));

  const sources = rows.map((row) => ({
    id: row.id,
    lastUpdated: row.lastUpdated,
    extractionStatus: row.extractionStatus,
    chunkCount: row.chunkCount,
  }));

  return {
    sourceIds,
    sources,
    scopeHash: buildScopeHash({ ownerEmail: params.ownerEmail, sourceIds, sources }),
  };
}
```

- [ ] **Step 2: Add a utility verification assertion for empty scopes**

Append this to `scripts/verify-rag-cache-utils.ts` before the final `console.log`:

```ts
assert.equal(
  buildScopeHash({ ownerEmail: "owner@example.com", sourceIds: [], sources: [] }),
  buildScopeHash({ ownerEmail: "owner@example.com", sourceIds: [], sources: [] })
);
```

- [ ] **Step 3: Run utility and type checks**

Run: `npx tsx scripts/verify-rag-cache-utils.ts`

Expected: `rag cache utility checks passed`.

Run: `npx tsc --noEmit`

Expected: no TypeScript errors from `lib/rag/cache/scope.ts`.

---

### Task 4: Add Text Final-Answer Cache Orchestration

**Files:**
- Create: `lib/rag/cache/answer.ts`
- Modify: `app/api/chat/public/route.ts`

- [ ] **Step 1: Create answer cache orchestration**

Create `lib/rag/cache/answer.ts`:

```ts
import crypto from "node:crypto";
import { embedQuery } from "@/lib/rag/embed";
import type { RetrievedChunk } from "@/lib/rag/types";
import { buildKnowledgeScope } from "./scope";
import { lookupAnswerCache, writeAnswerCache } from "./redis";
import { cacheLogFields, shouldSkipAnswerCache } from "./utils";
import type { AnswerCacheValue, RagCacheLookupResult } from "./types";

export async function getCachedAnswer(params: {
  ownerEmail: string;
  sourceIds: string[];
  question: string;
}): Promise<RagCacheLookupResult<AnswerCacheValue> & { embedding?: number[]; scopeHash?: string; normalizedSourceIds?: string[] }> {
  const skipReason = shouldSkipAnswerCache({ question: params.question });
  if (skipReason) return { status: "skip", reason: skipReason };

  const started = Date.now();
  try {
    const scope = await buildKnowledgeScope({ ownerEmail: params.ownerEmail, sourceIds: params.sourceIds });
    const embedding = await embedQuery(params.question);
    const result = await lookupAnswerCache({
      ownerEmail: params.ownerEmail,
      scopeHash: scope.scopeHash,
      embedding,
    });

    console.log(
      "[rag-cache] answer lookup",
      cacheLogFields({
        kind: "answer",
        result: result.status === "hit" ? "hit" : result.status === "miss" ? "miss" : "error",
        ownerEmail: params.ownerEmail,
        scopeHash: scope.scopeHash,
        distance: "distance" in result ? result.distance : undefined,
        elapsedMs: Date.now() - started,
      })
    );

    return { ...result, embedding, scopeHash: scope.scopeHash, normalizedSourceIds: scope.sourceIds };
  } catch (error) {
    console.error("[rag-cache] answer lookup error", error);
    return { status: "error", error };
  }
}

export async function saveCachedAnswer(params: {
  ownerEmail: string;
  sourceIds: string[];
  scopeHash?: string;
  question: string;
  embedding?: number[];
  answer: string;
  chunks: RetrievedChunk[];
}): Promise<void> {
  const skipReason = shouldSkipAnswerCache({
    question: params.question,
    answer: params.answer,
    chunks: params.chunks,
  });
  if (skipReason) {
    console.log("[rag-cache] answer write skipped", { reason: skipReason });
    return;
  }

  try {
    const scope = params.scopeHash
      ? { scopeHash: params.scopeHash, sourceIds: params.sourceIds }
      : await buildKnowledgeScope({ ownerEmail: params.ownerEmail, sourceIds: params.sourceIds });
    const embedding = params.embedding ?? (await embedQuery(params.question));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    await writeAnswerCache({
      id: crypto.randomUUID(),
      ownerEmail: params.ownerEmail,
      scopeHash: scope.scopeHash,
      sourceIds: scope.sourceIds,
      question: params.question,
      questionEmbedding: embedding,
      answer: params.answer,
      citations: params.chunks,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error("[rag-cache] answer write error", error);
  }
}
```

- [ ] **Step 2: Modify text chat route imports**

In `app/api/chat/public/route.ts`, add:

```ts
import { getCachedAnswer, saveCachedAnswer } from "@/lib/rag/cache/answer";
```

- [ ] **Step 3: Add cache lookup after `lastMessage` validation and before retrieval**

In `app/api/chat/public/route.ts`, after the user-message persistence block and before `// Retrieve via RAG`, add:

```ts
  const sourceIds = knowledge_source_ids ?? [];
  let answerCache: Awaited<ReturnType<typeof getCachedAnswer>> | null = null;

  if (lastMessage && lastMessage.role === "user" && sourceIds.length > 0) {
    answerCache = await getCachedAnswer({
      ownerEmail,
      sourceIds,
      question: lastMessage.content,
    });

    if (answerCache.status === "hit") {
      try {
        await db.insert(messagesTable).values({
          conversation_id: sessionId,
          role: "assistant",
          content: answerCache.value.answer,
        });
      } catch (error) {
        console.error("Database Persistence Error (Cached AI):", error);
      }
      return NextResponse.json({ response: answerCache.value.answer, cached: true });
    }
  }
```

- [ ] **Step 4: Reuse `sourceIds` in retrieval**

Replace this existing retrieval input:

```ts
sourceIds: knowledge_source_ids ?? [],
```

with:

```ts
sourceIds,
```

- [ ] **Step 5: Save successful generated answers to cache**

In `app/api/chat/public/route.ts`, after the assistant message persistence `try/catch` and before `return NextResponse.json({ response: reply });`, add:

```ts
    if (lastMessage && lastMessage.role === "user" && sourceIds.length > 0) {
      await saveCachedAnswer({
        ownerEmail,
        sourceIds: answerCache?.normalizedSourceIds ?? sourceIds,
        scopeHash: answerCache?.scopeHash,
        question: lastMessage.content,
        embedding: answerCache?.embedding,
        answer: reply,
        chunks,
      });
    }
```

- [ ] **Step 6: Run TypeScript**

Run: `npx tsc --noEmit`

Expected: no TypeScript errors from `app/api/chat/public/route.ts` or `lib/rag/cache/answer.ts`.

---

### Task 5: Add Voice Retrieved-Context Cache

**Files:**
- Create: `lib/rag/cache/context.ts`
- Modify: `app/api/widget/knowledge-search/route.ts`

- [ ] **Step 1: Create voice context cache orchestration**

Create `lib/rag/cache/context.ts`:

```ts
import crypto from "node:crypto";
import { embedQuery } from "@/lib/rag/embed";
import type { RetrievedChunk } from "@/lib/rag/types";
import { buildKnowledgeScope } from "./scope";
import { lookupContextCache, writeContextCache } from "./redis";
import { cacheLogFields, hasSensitiveContent, isLikelyStandaloneQuestion } from "./utils";
import type { ContextCacheValue, RagCacheLookupResult } from "./types";

export async function getCachedContext(params: {
  ownerEmail: string;
  sourceIds: string[];
  query: string;
}): Promise<RagCacheLookupResult<ContextCacheValue> & { embedding?: number[]; scopeHash?: string; normalizedSourceIds?: string[] }> {
  if (!isLikelyStandaloneQuestion(params.query)) return { status: "skip", reason: "not_standalone" };
  if (hasSensitiveContent(params.query)) return { status: "skip", reason: "sensitive_query" };

  const started = Date.now();
  try {
    const scope = await buildKnowledgeScope({ ownerEmail: params.ownerEmail, sourceIds: params.sourceIds });
    const embedding = await embedQuery(params.query);
    const result = await lookupContextCache({
      ownerEmail: params.ownerEmail,
      scopeHash: scope.scopeHash,
      embedding,
    });

    console.log(
      "[rag-cache] context lookup",
      cacheLogFields({
        kind: "context",
        result: result.status === "hit" ? "hit" : result.status === "miss" ? "miss" : "error",
        ownerEmail: params.ownerEmail,
        scopeHash: scope.scopeHash,
        distance: "distance" in result ? result.distance : undefined,
        elapsedMs: Date.now() - started,
      })
    );

    return { ...result, embedding, scopeHash: scope.scopeHash, normalizedSourceIds: scope.sourceIds };
  } catch (error) {
    console.error("[rag-cache] context lookup error", error);
    return { status: "error", error };
  }
}

export async function saveCachedContext(params: {
  ownerEmail: string;
  sourceIds: string[];
  scopeHash?: string;
  query: string;
  embedding?: number[];
  formattedContext: string;
  chunks: RetrievedChunk[];
}): Promise<void> {
  if (!params.formattedContext || params.chunks.length === 0) return;
  if (!isLikelyStandaloneQuestion(params.query) || hasSensitiveContent(params.query)) return;

  try {
    const scope = params.scopeHash
      ? { scopeHash: params.scopeHash, sourceIds: params.sourceIds }
      : await buildKnowledgeScope({ ownerEmail: params.ownerEmail, sourceIds: params.sourceIds });
    const embedding = params.embedding ?? (await embedQuery(params.query));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    await writeContextCache({
      id: crypto.randomUUID(),
      ownerEmail: params.ownerEmail,
      scopeHash: scope.scopeHash,
      sourceIds: scope.sourceIds,
      query: params.query,
      queryEmbedding: embedding,
      formattedContext: params.formattedContext,
      chunks: params.chunks,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error("[rag-cache] context write error", error);
  }
}
```

- [ ] **Step 2: Modify voice knowledge-search imports**

In `app/api/widget/knowledge-search/route.ts`, add:

```ts
import { getCachedContext, saveCachedContext } from "@/lib/rag/cache/context";
```

- [ ] **Step 3: Add cache lookup before `retrieveContext`**

In `app/api/widget/knowledge-search/route.ts`, inside the `try` block before `const chunks = await retrieveContext({`, add:

```ts
    const contextCache = await getCachedContext({
      ownerEmail: payload.ownerEmail,
      sourceIds: payload.sourceIds,
      query,
    });

    if (contextCache.status === "hit") {
      return NextResponse.json({ result: contextCache.value.formattedContext, cached: true });
    }
```

- [ ] **Step 4: Save formatted context after retrieval**

Replace the existing result block:

```ts
    const result = chunks.length === 0
      ? ""
      : chunks.map((c, i) => formatChunkForPrompt(c, i + 1)).join("\n\n");

    return NextResponse.json({ result });
```

with:

```ts
    const result = chunks.length === 0
      ? ""
      : chunks.map((c, i) => formatChunkForPrompt(c, i + 1)).join("\n\n");

    await saveCachedContext({
      ownerEmail: payload.ownerEmail,
      sourceIds: contextCache.normalizedSourceIds ?? payload.sourceIds,
      scopeHash: contextCache.scopeHash,
      query,
      embedding: contextCache.embedding,
      formattedContext: result,
      chunks,
    });

    return NextResponse.json({ result, cached: false });
```

- [ ] **Step 5: Run TypeScript**

Run: `npx tsc --noEmit`

Expected: no TypeScript errors from `app/api/widget/knowledge-search/route.ts` or `lib/rag/cache/context.ts`.

---

### Task 6: Manual Redis Verification And Fail-Open Checks

**Files:**
- No new files required.

- [ ] **Step 1: Verify no-Redis fail-open behavior**

Temporarily run without `REDIS_URL`.

Run: `npx tsc --noEmit`

Expected: TypeScript passes.

Run the app normally with the existing env: `npm run dev`.

Expected: text chat and voice knowledge search still work through Postgres RAG; Redis cache logs should not block responses.

- [ ] **Step 2: Verify Redis index creation with Redis Cloud/Stack**

Configure `REDIS_URL` for a Redis Cloud/Stack instance that supports RedisJSON and RediSearch vector indexes.

Run: `npm run dev`.

Send one text chat question with a selected section.

Expected logs include a Redis cache miss or setup message, and Redis contains indexes `idx:rag_answer_cache` and `idx:rag_context_cache`.

- [ ] **Step 3: Verify text answer cache hit**

Ask the same standalone cited question twice under the same business and selected source set.

Expected first response path: cache miss, normal retrieval and GPT response, cache write.

Expected second response path: cache hit, response JSON includes `cached: true`, and conversation messages are still persisted in Postgres.

- [ ] **Step 4: Verify voice context cache hit**

Call `/api/widget/knowledge-search` twice with the same voice token and query.

Expected first response path: context cache miss, normal `retrieveContext`, cache write.

Expected second response path: context cache hit, response JSON includes `cached: true`, and `result` has the same formatted context shape as the miss path.

- [ ] **Step 5: Verify safety skips**

Ask these text questions and confirm logs show `skip` and no final-answer cache write:

```text
What about that?
My email is user@example.com, what is my order status?
Can you create a support ticket?
```

Expected: normal RAG path runs when applicable, but shared answer cache is not used for these inputs.

- [ ] **Step 6: Final verification**

Run: `npx tsx scripts/verify-rag-cache-utils.ts`

Expected: `rag cache utility checks passed`.

Run: `npx tsc --noEmit`

Expected: no TypeScript errors.

Run: `git status --short`

Expected: only intentional files changed, with no commits created.
