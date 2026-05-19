import { db } from "@/db/client";
import { knowledge_source, knowledge_chunk } from "@/db/schema";
import { eq } from "drizzle-orm";
import { putOriginal } from "./blob";
import { extractPdf, extractCsv, extractWebsite } from "./extract";
import { chunkProse, chunkCsv, MAX_CHUNKS_PER_SOURCE } from "./chunk";
import { embedTexts } from "./embed";
import type { Chunk, IngestInput } from "./types";

export type IngestResult = { sourceId: string };

export async function ingestSource(input: IngestInput): Promise<IngestResult> {
  const t0 = Date.now();

  // 1. Persist original to Blob (skipped for "text" type — no original file)
  let blobUrl: string | undefined;
  let blobPath: string | undefined;
  if (input.type === "pdf" || input.type === "csv") {
    const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const r = await putOriginal(
      `knowledge/${input.userEmail}/${Date.now()}-${safeName}`,
      input.bytes,
      input.type === "pdf" ? "application/pdf" : "text/csv"
    );
    blobUrl = r.url;
    blobPath = r.pathname;
  } else if (input.type === "website") {
    const r = await putOriginal(
      `knowledge/${input.userEmail}/${Date.now()}-website.md`,
      input.markdown,
      "text/markdown"
    );
    blobUrl = r.url;
    blobPath = r.pathname;
  }

  // 2. Insert knowledge_source row
  const [source] = await db
    .insert(knowledge_source)
    .values({
      user_email: input.userEmail,
      type:
        input.type === "website"
          ? "website"
          : input.type === "text"
          ? "text"
          : "upload",
      name:
        input.type === "website"
          ? input.url
          : input.type === "text"
          ? input.title
          : input.fileName,
      status: "active",
      source_url: input.type === "website" ? input.url : undefined,
      blob_url: blobUrl,
      blob_pathname: blobPath,
      extraction_status: "pending",
      meta_data: buildSourceMetadata(input),
    })
    .returning({ id: knowledge_source.id });

  const sourceId = source.id;

  try {
    // 3. Mark extracting
    await db
      .update(knowledge_source)
      .set({ extraction_status: "extracting" })
      .where(eq(knowledge_source.id, sourceId));

    // 4. Extract + chunk
    const chunks: Chunk[] = await extractAndChunk(input);

    if (chunks.length === 0) {
      throw new Error("No content extracted");
    }
    if (chunks.length > MAX_CHUNKS_PER_SOURCE) {
      throw new Error(
        `Source has ${chunks.length} chunks (max ${MAX_CHUNKS_PER_SOURCE}). Please split the file.`
      );
    }

    // 5. Embed
    await db
      .update(knowledge_source)
      .set({ extraction_status: "embedding" })
      .where(eq(knowledge_source.id, sourceId));

    const embedT0 = Date.now();
    const vectors = await embedTexts(chunks.map((c) => c.content));
    const embedMs = Date.now() - embedT0;

    // 6. Bulk insert chunks. Drizzle vector helper takes number[].
    await db.insert(knowledge_chunk).values(
      chunks.map((c) => ({
        source_id: sourceId,
        user_email: input.userEmail,
        chunk_index: String(c.chunkIndex),
        chunk_type: c.chunkType,
        content: c.content,
        embedding: vectors[c.chunkIndex],
        meta_data: JSON.stringify(c.metadata),
      }))
    );

    // 7. Mark ready
    await db
      .update(knowledge_source)
      .set({
        extraction_status: "ready",
        chunk_count: String(chunks.length),
      })
      .where(eq(knowledge_source.id, sourceId));

    console.log("[ingest] ok", {
      source_id: sourceId,
      chunk_count: chunks.length,
      total_ms: Date.now() - t0,
      embed_ms: embedMs,
    });

    return { sourceId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(knowledge_source)
      .set({ extraction_status: "failed", extraction_error: msg })
      .where(eq(knowledge_source.id, sourceId));
    throw err; // route handler classifies and shapes user-facing response
  }
}

async function extractAndChunk(input: IngestInput): Promise<Chunk[]> {
  if (input.type === "pdf") {
    const r = await extractPdf(input.bytes);
    if (r.type !== "pdf") throw new Error("extractPdf returned wrong type");
    return chunkProse(r.text, r.pageBoundaries);
  }
  if (input.type === "csv") {
    const r = extractCsv(input.bytes, input.fileName);
    if (r.type !== "csv") throw new Error("extractCsv returned wrong type");
    return chunkCsv(r);
  }
  if (input.type === "website") {
    const r = extractWebsite(input.markdown);
    if (r.type !== "website") throw new Error("extractWebsite returned wrong type");
    return chunkProse(r.markdown);
  }
  // text
  return chunkProse(input.content);
}

function buildSourceMetadata(input: IngestInput): string | undefined {
  if (input.type === "pdf") {
    return JSON.stringify({
      fileName: input.fileName,
      fileSize: input.fileSize,
      fileType: "pdf",
    });
  }
  if (input.type === "csv") {
    return JSON.stringify({
      fileName: input.fileName,
      fileSize: input.fileSize,
      fileType: "csv",
    });
  }
  return undefined;
}
