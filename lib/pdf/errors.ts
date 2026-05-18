export class PdfEncryptedError extends Error {
  constructor() {
    super("PDF is password-protected");
    this.name = "PdfEncryptedError";
  }
}

export class PdfTooLargeError extends Error {
  constructor(public readonly pageCount: number) {
    super(`PDF has ${pageCount} pages (maximum 30)`);
    this.name = "PdfTooLargeError";
  }
}

export class PdfCorruptError extends Error {
  constructor(cause?: unknown) {
    super("PDF could not be parsed");
    this.name = "PdfCorruptError";
    if (cause instanceof Error) this.cause = cause;
  }
}

export class PdfImageOnlyError extends Error {
  constructor() {
    super("PDF contains no extractable text (likely scanned/image-based)");
    this.name = "PdfImageOnlyError";
  }
}
