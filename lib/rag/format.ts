import type { RetrievedChunk } from "./types";

export function formatChunkForPrompt(c: RetrievedChunk, n: number): string {
  let header = `[${n}] Source: ${c.sourceName}`;

  if (c.chunkType === "prose" && c.pageNumber !== undefined) {
    header += `, page ${c.pageNumber}`;
  } else if (c.chunkType === "csv_row" && c.csvRowIndex !== undefined) {
    // Inline a short snippet so the model sees the row's identity in the header.
    const firstLine = c.content.split("\n")[0].slice(0, 80);
    header += `, row ${c.csvRowIndex} (${firstLine})`;
  } else if (c.chunkType === "csv_summary") {
    header += ` (dataset summary)`;
  }

  return `${header}\n${c.content}`;
}
