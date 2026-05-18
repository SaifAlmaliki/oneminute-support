# PDF Upload Support for Knowledge Sources

**Date:** 2026-05-18
**Status:** Approved, ready for implementation plan
**Scope:** Extend the dashboard's "Add Source → File Upload" path to accept PDFs (in addition to CSV), up to 15MB and 30 pages, with text extraction only (no OCR).

## Background

Today, `/api/knowledge/store` accepts CSV uploads up to 10MB. The frontend `addKnowledgeModal.tsx` gates `accept=".csv,text/csv"` and a 10MB size check; the backend reads the file as text and runs `summarizeMarkdown` on the whole thing. There is no vector store — the resulting summary is stored as a single dense blob in `knowledge_source.content` and concatenated into chat prompts at runtime.

Users want to upload PDFs (product manuals, policies, FAQs) so the support bot can answer from them. PDFs differ from CSVs in two ways that matter: they are binary (need a parser), and a single PDF can contain far more text than a typical CSV.

## Goals

- Accept PDF uploads up to 15MB through the existing Add Source modal.
- Extract text page-by-page on the server.
- Apply the same conditional-summarization rule the `text` type already uses (summarize only when long).
- Match the existing knowledge-source storage model (one row in `knowledge_source`, no chunking, no embeddings).
- Keep the implementation tight — no background jobs, no queues, no OCR for now.

## Non-goals

- **OCR for image-based / scanned PDFs.** Out of scope. We detect them and reject with a clear message; users can revisit OCR as a follow-up.
- **Per-page chunking or embedding.** The architecture stores one summarized blob per source; PDFs follow the same convention.
- **Async processing / background jobs.** Synchronous upload, page-cap to keep within Vercel timeouts.
- **PDFs >30 pages or >15MB.** Hard limits with informative errors.
- **Other file types** (DOCX, TXT, MD, images). Not in this change.

## Constraints

- **Vercel serverless runtime.** No native binaries, no `pdf-parse` (which depends on a problematic native module). PDF library must be pure JS.
- **Function timeout.** Set `export const maxDuration = 300`. The 30-page cap is sized so synchronous extraction stays well under that.
- **No test runner configured.** Verification is manual through the dashboard.
- **No FK constraints in the schema.** Continue to follow the existing pattern (string keys, `text` ids, `text` timestamps).

## Design

### End-to-end flow

1. User selects a `.pdf` (or `.csv`) in the Add Source modal.
2. Frontend validates extension/MIME and size (≤15MB), POSTs multipart to `/api/knowledge/store`.
3. Server branches on extension:
   - **CSV** — unchanged behavior.
   - **PDF** — call `extractPdfText(buffer)`, then apply the same `>8000 chars → summarize, else verbatim` rule used by the `text` type.
4. Insert one row in `knowledge_source` with `type: "upload"` and PDF metadata in `meta_data`.

### Component breakdown

**New: `lib/pdf/extractPdf.ts`** — single export:

```ts
export async function extractPdfText(
  buffer: Buffer
): Promise<{ text: string; pageCount: number }>
```

Responsibilities:

- Load the PDF using `pdfjs-dist`'s legacy Node build (`pdfjs-dist/legacy/build/pdf.mjs`). Pure JS, runs on Vercel serverless without native deps.
- Throw `PdfEncryptedError` if the document is password-protected.
- Throw `PdfCorruptError` if pdfjs fails to load the document.
- Throw `PdfTooLargeError(pageCount)` if `pageCount > 30`.
- Iterate pages 1..N, call `getTextContent()` on each, join `item.str` values with spaces.
- Concatenate pages with `\n\n--- Page N ---\n\n` markers so the model has structural context.
- Throw `PdfImageOnlyError` if total extracted text is < 100 chars across the whole document.
- Return `{ text, pageCount }`.

**Modified: `app/api/knowledge/store/route.ts`**

- Add `export const maxDuration = 300`.
- In the multipart branch, detect PDFs by file extension (`.pdf`) or MIME (`application/pdf`).
- For PDF: read `await file.arrayBuffer()` → `Buffer`, call `extractPdfText`, then run the same `length > 8000 ? summarizeMarkdown(text) : text` logic as the `text` branch.
- Map the typed errors to 400 responses with specific messages (see Error Handling below).
- `meta_data` JSON: `{ fileName, fileSize, pageCount, fileType: "pdf" }`.

**Modified: `components/dashboard/knowledge/addKnowledgeModal.tsx`**

- Widen the `<input>` `accept` to `.csv,.pdf,text/csv,application/pdf`.
- Bump the size cap from 10MB to 15MB.
- Update the validation branch: accept either CSV or PDF; error becomes `"Only CSV and PDF files are allowed"`.
- Update size error to `"File size must be less than 15MB"`.
- Update the helper line under the upload zone from `"CSV (max 10MB)"` to `"CSV or PDF (max 15MB)"`.
- Update the input element id (currently `csv-file-input`) to a neutral name like `knowledge-file-input` for clarity.

### Data flow

```
File (≤15MB, .pdf) → Buffer → pdfjs-dist load
  → page count check (≤30)
  → for each page: getTextContent() → join strings
  → concat with page markers
  → total chars < 100? throw PdfImageOnlyError
  → length > 8000? summarizeMarkdown(text) : text
  → INSERT into knowledge_source → 200
```

### Error handling

| Failure | HTTP | Message |
|---|---|---|
| File >15MB | 400 (client-side first) | `"File size must be less than 15MB"` |
| Wrong file type | 400 (client-side first) | `"Only CSV and PDF files are allowed"` |
| `PdfEncryptedError` | 400 | `"This PDF is password-protected. Please upload an unlocked version."` |
| `PdfTooLargeError(N)` | 400 | `` `PDF has ${N} pages. Maximum supported is 30 pages — please split the file.` `` |
| `PdfCorruptError` | 400 | `"Could not read this PDF. The file may be corrupted."` |
| `PdfImageOnlyError` | 400 | `"This PDF appears to be scanned or image-based. We can't extract text from it yet — please upload a text-based PDF."` |
| Anything else | 500 | Generic, real cause logged via `console.error` (existing convention) |

The frontend already surfaces server error JSON in the modal's `Alert`; no UI changes required for error display beyond the validation messages above.

### Storage model

Same `knowledge_source` row shape as today:

- `type: "upload"` (unchanged value)
- `name: file.name`
- `content`: extracted text (verbatim if ≤8000 chars, summarized otherwise)
- `meta_data`: `JSON.stringify({ fileName, fileSize, pageCount, fileType: "pdf" })`
- `status: "active"`
- `user_email`: from `isAuthorized()`

Existing CSV rows continue to use the current `meta_data` shape (`{ fileName, fileSize, rowCount, headers }`); the two metadata shapes coexist. Consumers of `meta_data` already JSON.parse defensively.

### Why these choices

- **`pdfjs-dist` legacy build over `pdf-parse`/`pdf2json`.** `pdf-parse` has a buggy postinstall step on Vercel; `pdf2json` doesn't expose per-page text cleanly. `pdfjs-dist` is what Mozilla ships, runs as pure JS on Node, and gives us per-page text via `getTextContent()`. Risk: it has a larger bundle. Mitigated by importing the legacy Node build only in this server module.
- **30-page cap.** A 30-page text PDF extracts in a few seconds. Sized for safety on Vercel even if a future change adds OCR back. Users hitting the cap get a precise error and can split.
- **15MB cap.** Vercel's default body limit on serverless functions is 4.5MB for Hobby and effectively unlimited via streaming on Pro; for a 15MB upload we may need to handle this through the App Router's `Request.arrayBuffer()` (which streams). The plan should verify body size on the deployed environment as part of the first-step spike.
- **Conditional summarization (>8000 chars).** Mirrors the existing `text` branch behavior, keeping a consistent rule across upload paths. Short PDFs stay lossless; long ones avoid blowing context windows.
- **No OCR.** Explicit non-goal for this iteration. The image-only detection gives a clear failure signal so users aren't silently disappointed.
- **Two lib files (extractor only this round).** Extraction is isolated from the route so it can be tested or swapped without touching the API surface.

## Testing

Manual verification through the dashboard:

1. Small text PDF (~2 pages, exported from Google Docs) → imports, stored verbatim, bot answers specifics.
2. Long text PDF (~20 pages, product manual) → imports, summarized, bot answers high-level questions.
3. 31-page PDF → 400 with the page-count error.
4. 16MB PDF → 400 client-side before hitting server.
5. Scanned/image-only PDF → 400 with the image-based error.
6. Password-protected PDF → 400 with the encrypted error.
7. Renamed `.txt` → `.pdf` → 400 with the corrupt error.
8. Regression: CSV upload still works at the new 15MB cap.

Re-run #1 and #2 on Vercel after deploy to confirm `pdfjs-dist` works in the serverless runtime. This is the highest-risk piece and should be a throwaway-branch spike as the first plan step before building the rest.

## Risks & open questions

- **`pdfjs-dist` on Vercel serverless.** Pure-JS legacy build *should* work, but the spike must confirm. Fallback if it doesn't: try `unpdf` (a lighter Vercel-friendly fork of pdfjs).
- **Body size limit at 15MB.** Verify Vercel accepts a 15MB multipart upload to a serverless function on the deployment target plan; if not, we may need to drop the cap or move to streaming/edge.
- **`summarizeMarkdown` token cost on 30-page PDFs.** A 30-page text PDF could be ~60k tokens of input to GPT-4o-mini for summarization. Acceptable cost but worth being aware of — not blocking.

## Out of scope (follow-ups)

- OCR for scanned PDFs (chosen approach when revisited: GPT-4o vision per sparse page).
- DOCX / TXT / MD support.
- Per-page chunking and vector search.
- Async ingestion with status polling.
