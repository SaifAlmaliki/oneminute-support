import fs from "node:fs/promises";
import path from "node:path";
import { extractPdfText } from "../lib/pdf/extractPdf";
import {
  PdfCorruptError,
  PdfEncryptedError,
  PdfImageOnlyError,
  PdfTooLargeError,
} from "../lib/pdf/errors";

async function run() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npx tsx scripts/verify-pdf-extract.ts <pdf-path>");
    process.exit(1);
  }

  const abs = path.resolve(arg);
  const buffer = await fs.readFile(abs);
  console.log(`Loaded ${abs} (${buffer.length} bytes)`);

  try {
    const { text, pageCount } = await extractPdfText(buffer);
    console.log(`Pages: ${pageCount}`);
    console.log(`Total chars: ${text.length}`);
    console.log("--- First 500 chars ---");
    console.log(text.slice(0, 500));
    console.log("--- (end) ---");
  } catch (err) {
    if (err instanceof PdfEncryptedError) {
      console.log("Result: ENCRYPTED");
    } else if (err instanceof PdfTooLargeError) {
      console.log(`Result: TOO_LARGE (pageCount=${err.pageCount})`);
    } else if (err instanceof PdfCorruptError) {
      console.log("Result: CORRUPT");
    } else if (err instanceof PdfImageOnlyError) {
      console.log("Result: IMAGE_ONLY");
    } else {
      console.error("Result: UNEXPECTED_ERROR");
      console.error(err);
      process.exit(2);
    }
  }
}

run();
