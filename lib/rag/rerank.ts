import { CohereClientV2 } from "cohere-ai";

const cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY! });

const RERANK_MODEL = "rerank-v3.5";
const MIN_RELEVANCE_SCORE = 0.05;

export type RerankResult = { index: number; relevance: number };

/**
 * Rerank `documents` against `query` using Cohere's rerank endpoint.
 *
 * Returns an array of `{ index, relevance }` ordered best-first, capped at
 * `topN`. Returns `[]` when `documents` is empty. Returns `null` on any error
 * so the caller can fall back to RRF order.
 *
 * Adapted for cohere-ai v8.x: the rerank method lives on the V2 namespace
 * (`client.v2.rerank`) accessed via the `CohereClientV2` class. Response items
 * still expose `index` and `relevanceScore` (camelCase) on each result.
 */
export async function rerank(
  query: string,
  documents: string[],
  topN: number
): Promise<RerankResult[] | null> {
  if (documents.length === 0) return [];
  try {
    const res = await cohere.rerank({
      model: RERANK_MODEL,
      query,
      documents,
      topN: Math.min(topN, documents.length),
    });
    return res.results.map((r) => ({
      index: r.index,
      relevance: r.relevanceScore,
    }));
  } catch (err) {
    console.error("Cohere rerank failed, falling back to RRF order:", err);
    return null;
  }
}

export { MIN_RELEVANCE_SCORE };
