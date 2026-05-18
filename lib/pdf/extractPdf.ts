import {
  PdfCorruptError,
  PdfEncryptedError,
  PdfImageOnlyError,
  PdfTooLargeError,
} from "./errors";

const MAX_PAGES = 30;
const MIN_TOTAL_TEXT_CHARS = 100;

export async function extractPdfText(
  buffer: Buffer
): Promise<{ text: string; pageCount: number }> {
  // Lazy-load the legacy ES build; importing at module scope drags
  // pdfjs setup into every cold start that touches this file's imports.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  let doc: any;
  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    doc = await loadingTask.promise;
  } catch (err: any) {
    if (
      err?.name === "PasswordException" ||
      /password/i.test(err?.message ?? "")
    ) {
      throw new PdfEncryptedError();
    }
    throw new PdfCorruptError(err);
  }

  try {
    const pageCount: number = doc.numPages;
    if (pageCount > MAX_PAGES) {
      throw new PdfTooLargeError(pageCount);
    }

    const pageTexts: string[] = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: any) => (typeof item.str === "string" ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pageTexts.push(`--- Page ${i} ---\n\n${pageText}`);
    }

    const text = pageTexts.join("\n\n").trim();

    const totalTextChars = text
      .replace(/--- Page \d+ ---/g, "")
      .replace(/\s/g, "").length;

    if (totalTextChars < MIN_TOTAL_TEXT_CHARS) {
      throw new PdfImageOnlyError();
    }

    return { text, pageCount };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
