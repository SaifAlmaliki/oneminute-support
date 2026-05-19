import { parse } from "csv-parse/sync";
import { extractPdfText } from "@/lib/pdf/extractPdf";
import type { ExtractedSource } from "./types";

export async function extractPdf(buffer: Buffer): Promise<ExtractedSource> {
  // extractPdfText already validates page count, encryption, image-only,
  // and corruption — propagates typed errors from lib/pdf/errors.ts.
  const { text, pageCount } = await extractPdfText(buffer);

  // Build pageBoundaries: char index where each "--- Page N ---" header starts.
  // The chunker uses this to assign page_number to each prose chunk.
  const boundaries: number[] = [];
  const re = /--- Page (\d+) ---/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) boundaries.push(m.index);

  return { type: "pdf", text, pageBoundaries: boundaries, pageCount };
}

export function extractCsv(buffer: Buffer, fileName: string): ExtractedSource {
  const records = parse(buffer.toString("utf8"), {
    columns: false,         // we want headers separately
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
  }) as string[][];

  if (records.length === 0) {
    throw new Error("CSV file is empty");
  }

  const [headerRow, ...dataRows] = records;
  const headers = headerRow.map((h) => h.trim());

  const rows = dataRows.map((values, i) => ({ rowIndex: i, values }));

  return { type: "csv", rows, headers, fileName };
}

export function extractWebsite(markdown: string): ExtractedSource {
  return { type: "website", markdown };
}
