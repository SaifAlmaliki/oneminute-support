export type ChunkType = "prose" | "csv_row" | "csv_summary";

export type Chunk = {
  chunkIndex: number;
  chunkType: ChunkType;
  content: string;
  metadata: ChunkMetadata;
};

export type ChunkMetadata = {
  pageNumber?: number;       // PDF
  csvRowIndex?: number;      // CSV row
  headers?: string[];        // CSV
  rowCount?: number;         // CSV summary
  fileName?: string;         // CSV summary
};

export type RetrievedChunk = {
  content: string;
  sourceName: string;
  sourceId: string;
  chunkIndex: number;
  chunkType: ChunkType;
  pageNumber?: number;
  csvRowIndex?: number;
  rerankScore: number;
};

export type ExtractedSource =
  | { type: "pdf"; text: string; pageBoundaries: number[]; pageCount: number }
  | { type: "csv"; rows: { rowIndex: number; values: string[] }[]; headers: string[]; fileName: string }
  | { type: "website"; markdown: string };

export type IngestInput =
  | { type: "pdf"; userEmail: string; fileName: string; bytes: Buffer; fileSize: number }
  | { type: "csv"; userEmail: string; fileName: string; bytes: Buffer; fileSize: number }
  | { type: "website"; userEmail: string; url: string; markdown: string }
  | { type: "text"; userEmail: string; title: string; content: string };
