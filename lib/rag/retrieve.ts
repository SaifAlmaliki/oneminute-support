import { db } from "@/db/client";
import { sql } from "drizzle-orm";
import { embedQuery } from "./embed";
import { rerank, MIN_RELEVANCE_SCORE } from "./rerank";
import type { RetrievedChunk } from "./types";

const CANDIDATE_TOP_K = 20;
const RRF_K = 60;

type Candidate = {
  id: string;
  source_id: string;
  source_name: string;
  content: string;
  chunk_type: "prose" | "csv_row" | "csv_summary";
  chunk_index: string;
  meta_data: string | null;
};

export async function retrieveContext({
  query,
  sourceIds,
  userEmail,
  topK = 5,
}: {
  query: string;
  sourceIds: string[];
  userEmail: string;
  topK?: number;
}): Promise<RetrievedChunk[]> {
  if (sourceIds.length === 0 || query.trim().length === 0) return [];

  const queryVec = await embedQuery(query);
  // pgvector accepts the literal "[1,2,3]" form for vector params.
  const vecLiteral = `[${queryVec.join(",")}]`;

  const [vectorRes, ftsRes] = await Promise.all([
    db.execute(sql`
      SELECT k.id, k.source_id, s.name AS source_name, k.content, k.chunk_type,
             k.chunk_index, k.meta_data
      FROM knowledge_chunk k
      JOIN knowledge_source s ON s.id = k.source_id
      WHERE k.source_id = ANY(${sourceIds})
        AND k.user_email = ${userEmail}
      ORDER BY k.embedding <=> ${vecLiteral}::vector
      LIMIT ${CANDIDATE_TOP_K}
    `),
    db.execute(sql`
      SELECT k.id, k.source_id, s.name AS source_name, k.content, k.chunk_type,
             k.chunk_index, k.meta_data
      FROM knowledge_chunk k
      JOIN knowledge_source s ON s.id = k.source_id
      WHERE k.source_id = ANY(${sourceIds})
        AND k.user_email = ${userEmail}
        AND k.fts @@ plainto_tsquery('english', ${query})
      ORDER BY ts_rank(k.fts, plainto_tsquery('english', ${query})) DESC
      LIMIT ${CANDIDATE_TOP_K}
    `),
  ]);

  // Defensive: neon-http returns `{ rows: T[] }`, but normalize either shape.
  const vectorRows: Candidate[] =
    ((vectorRes as any).rows ?? (vectorRes as any)) as Candidate[];
  const ftsRows: Candidate[] =
    ((ftsRes as any).rows ?? (ftsRes as any)) as Candidate[];

  // Reciprocal Rank Fusion
  const rrf = new Map<string, { score: number; cand: Candidate }>();
  const accrue = (rows: Candidate[]) => {
    rows.forEach((cand, rank) => {
      const prev = rrf.get(cand.id);
      const inc = 1 / (RRF_K + rank + 1);
      if (prev) prev.score += inc;
      else rrf.set(cand.id, { score: inc, cand });
    });
  };
  accrue(vectorRows);
  accrue(ftsRows);

  const fused = [...rrf.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_TOP_K)
    .map((x) => x.cand);

  if (fused.length === 0) {
    console.log("[retrieve] empty after RRF", { query, sourceIds });
    return [];
  }

  const reranked = await rerank(
    query,
    fused.map((c) => c.content),
    topK
  );

  // Fallback: rerank failed → use top-K by RRF order (no score gating).
  if (reranked === null) {
    return fused.slice(0, topK).map((c) => toRetrievedChunk(c, 0));
  }

  // Drop low-confidence results.
  const filtered = reranked.filter((r) => r.relevance >= MIN_RELEVANCE_SCORE);
  if (filtered.length === 0) {
    console.log("[retrieve] all below threshold", {
      query,
      topScore: reranked[0]?.relevance ?? 0,
    });
    return [];
  }

  console.log("[retrieve] ok", {
    query_len: query.length,
    vector_hits: vectorRows.length,
    fts_hits: ftsRows.length,
    rrf_candidates: fused.length,
    top_rerank_score: filtered[0].relevance,
    returned: filtered.length,
  });

  return filtered.map((r) => toRetrievedChunk(fused[r.index], r.relevance));
}

function toRetrievedChunk(c: Candidate, relevance: number): RetrievedChunk {
  const meta = c.meta_data ? JSON.parse(c.meta_data) : {};
  return {
    content: c.content,
    sourceName: c.source_name,
    sourceId: c.source_id,
    chunkIndex: parseInt(c.chunk_index, 10),
    chunkType: c.chunk_type,
    pageNumber: meta.pageNumber,
    csvRowIndex: meta.csvRowIndex,
    rerankScore: relevance,
  };
}
