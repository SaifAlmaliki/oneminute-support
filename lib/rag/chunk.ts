import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Chunk, ExtractedSource } from "./types";

const PROSE_CHUNK_TOKENS = 800;
const PROSE_CHUNK_OVERLAP_TOKENS = 120;
// Approx 4 chars/token for English — RecursiveCharacterTextSplitter is char-based.
const CHARS_PER_TOKEN = 4;

const CSV_MIN_CHUNK_CHARS = 50;

export async function chunkProse(
  text: string,
  pageBoundaries: number[] = []
): Promise<Chunk[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: PROSE_CHUNK_TOKENS * CHARS_PER_TOKEN,
    chunkOverlap: PROSE_CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN,
    separators: ["\n\n", "\n", ". ", " ", ""],
  });

  const docs = await splitter.createDocuments([text]);

  return docs.map((doc, i) => {
    // Find page number by locating which boundary the chunk start falls into.
    let pageNumber: number | undefined;
    if (pageBoundaries.length > 0) {
      // doc.metadata may have a `loc` from langchain but it's char-based and unreliable
      // across separator splits. Use a substring search as a robust fallback.
      const startIdx = text.indexOf(doc.pageContent.slice(0, 60));
      if (startIdx >= 0) {
        for (let p = pageBoundaries.length - 1; p >= 0; p--) {
          if (startIdx >= pageBoundaries[p]) {
            pageNumber = p + 1;
            break;
          }
        }
      }
    }

    return {
      chunkIndex: i,
      chunkType: "prose" as const,
      content: doc.pageContent,
      metadata: pageNumber !== undefined ? { pageNumber } : {},
    };
  });
}

export function chunkCsv(extracted: Extract<ExtractedSource, { type: "csv" }>): Chunk[] {
  const { headers, rows, fileName } = extracted;
  const chunks: Chunk[] = [];

  // Row-as-chunk with coalescing
  let pending = "";
  let pendingStartRow = -1;

  rows.forEach((r) => {
    const rowText = headers
      .map((h, i) => `${h}: ${r.values[i] ?? ""}`)
      .join(" | ");

    if (rowText.length < CSV_MIN_CHUNK_CHARS && pending.length === 0) {
      pending = rowText;
      pendingStartRow = r.rowIndex;
      return;
    }

    if (pending.length > 0) {
      const merged = `${pending}\n${rowText}`;
      if (merged.length >= CSV_MIN_CHUNK_CHARS) {
        chunks.push({
          chunkIndex: chunks.length,
          chunkType: "csv_row",
          content: merged,
          metadata: { csvRowIndex: pendingStartRow, headers },
        });
        pending = "";
        pendingStartRow = -1;
      } else {
        pending = merged;
      }
      return;
    }

    chunks.push({
      chunkIndex: chunks.length,
      chunkType: "csv_row",
      content: rowText,
      metadata: { csvRowIndex: r.rowIndex, headers },
    });
  });

  if (pending.length > 0) {
    chunks.push({
      chunkIndex: chunks.length,
      chunkType: "csv_row",
      content: pending,
      metadata: { csvRowIndex: pendingStartRow, headers },
    });
  }

  // Summary chunk
  const sample = rows.slice(0, 3).map((r) =>
    headers.map((h, i) => `${h}: ${r.values[i] ?? ""}`).join(" | ")
  ).join(" ;; ");

  const summary = `This dataset is named ${fileName}. It has ${rows.length} rows and columns: ${headers.join(", ")}. Sample rows: ${sample.slice(0, 600)}`;

  chunks.push({
    chunkIndex: chunks.length,
    chunkType: "csv_summary",
    content: summary,
    metadata: { rowCount: rows.length, headers, fileName },
  });

  return chunks;
}

export const MAX_CHUNKS_PER_SOURCE = 2000;
