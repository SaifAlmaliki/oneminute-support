# PDF Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to upload PDF files (≤15MB, ≤30 pages) as knowledge sources alongside the existing CSV uploader.

**Architecture:** Pure-JS text extraction with `pdfjs-dist` legacy build, no OCR. PDFs flow through the existing `/api/knowledge/store` route, get extracted page-by-page on the server, then follow the existing `text > 8000 chars → summarize, else verbatim` rule. One `knowledge_source` row per upload, same as CSV.

**Tech Stack:** Next.js 16 App Router (Node runtime serverless), TypeScript, `pdfjs-dist@^4` legacy Node build, existing OpenAI helper, existing Drizzle schema.

**Spec:** `docs/superpowers/specs/2026-05-18-pdf-upload-design.md`

**Repo conventions to follow:**
- No test runner exists. Tests in this plan are *manual verification scripts* run via `npx tsx scripts/...` and through the dashboard. Do not add a Jest/Vitest setup.
- The user pushes to GitHub themselves — never run `git push`.
- Generic error responses + `console.error(realCause)` is the existing convention.

**Risk-first ordering:** Task 1 is a runtime spike to confirm `pdfjs-dist` works on Vercel before any UI/API work, because if it doesn't we need a different library and the rest of the plan changes.

---

## File Structure

**New files:**
- `lib/pdf/errors.ts` — typed error classes for PDF failures (`PdfEncryptedError`, `PdfTooLargeError`, `PdfCorruptError`, `PdfImageOnlyError`).
- `lib/pdf/extractPdf.ts` — single export `extractPdfText(buffer: Buffer): Promise<{ text: string; pageCount: number }>`. Owns all `pdfjs-dist` interaction.
- `scripts/verify-pdf-extract.ts` — runnable script for manual verification (loads a sample PDF from disk and prints the extraction result). Used in Task 1 (Vercel spike) and Tasks 6/7 (full verification).
- `scripts/fixtures/` — directory containing sample PDFs used by the verify script.

**Modified files:**
- `app/api/knowledge/store/route.ts` — add a PDF branch in the multipart handler; add `export const maxDuration = 300`.
- `components/dashboard/knowledge/addKnowledgeModal.tsx` — widen `accept`, bump size cap, update error/help text, rename input id.
- `package.json` — add `pdfjs-dist` and `tsx` (dev) dependencies.

---

## Task 1: Vercel runtime spike for `pdfjs-dist`

**Why first:** The whole plan rests on `pdfjs-dist` legacy build working in Vercel's Node serverless runtime. If it doesn't, we swap to `unpdf` and adjust later tasks. This is a throwaway probe — the temporary route gets deleted at the end.

**Files:**
- Create: `app/api/_pdf-spike/route.ts` (temporary, deleted in step 7)
- Modify: `package.json`

- [ ] **Step 1: Install `pdfjs-dist`**

Run:
```bash
npm install pdfjs-dist@^4
```

Expected: `package.json` gets `"pdfjs-dist": "^4.x.x"` under `dependencies`.

- [ ] **Step 2: Create the spike route**

Create `app/api/_pdf-spike/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;

    const firstPage = await doc.getPage(1);
    const textContent = await firstPage.getTextContent();
    const sample = textContent.items
      .map((item: any) => item.str)
      .join(" ")
      .slice(0, 200);

    await doc.destroy();

    return NextResponse.json({
      ok: true,
      pageCount,
      firstPageSample: sample,
      bufferBytes: buffer.length,
    });
  } catch (err: any) {
    console.error("[pdf-spike] error:", err);
    return NextResponse.json(
      { ok: false, name: err?.name, message: err?.message },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Verify locally**

Run:
```bash
npm run dev
```

In a second terminal, with any small text-based PDF on disk (use any local PDF; if none available, the user has plenty in their dashboard mocks):
```bash
curl -X POST -F "file=@<path-to-some.pdf>" http://localhost:3000/api/_pdf-spike
```

Expected: HTTP 200 with JSON like `{"ok":true,"pageCount":N,"firstPageSample":"...","bufferBytes":...}` and the sample contains real words from the PDF.

If you see an error about `DOMMatrix`, `Path2D`, or `canvas` — that's expected for image-rendering paths but should NOT happen for text extraction alone. If it does, the legacy build is misimported. Re-check the import path is exactly `pdfjs-dist/legacy/build/pdf.mjs`.

- [ ] **Step 4: Verify on Vercel preview**

Commit the spike route, push the branch the user is working on, and wait for the Vercel preview deploy (the user handles `git push`; ask them to trigger the deploy and share the preview URL).

Once the preview URL is live, run:
```bash
curl -X POST -F "file=@<path-to-some.pdf>" https://<preview-url>/api/_pdf-spike
```

Expected: same successful JSON. If this fails on Vercel but worked locally, STOP — open `unpdf` (https://github.com/unjs/unpdf) as a fallback and update `lib/pdf/extractPdf.ts` accordingly when you build it. Do not proceed to Task 2 until extraction is confirmed working on Vercel.

- [ ] **Step 5: Verify the 15MB upload works on Vercel**

Find or create a ~12-15MB PDF (a long PDF with embedded images works fine — text content doesn't matter for this test, only body size).
```bash
curl -X POST -F "file=@<large.pdf>" https://<preview-url>/api/_pdf-spike
```

Expected: HTTP 200. If the response is HTTP 413 / "Request body too large", note this in the spec's "Risks" section and flag to the user that we may need to lower the cap to whatever Vercel accepts on the deployment plan. Don't block on this — proceed but with the appropriate cap.

- [ ] **Step 6: Document the result**

If everything passed, append a one-line note at the end of `docs/superpowers/specs/2026-05-18-pdf-upload-design.md`:
```
**2026-05-18 spike result:** pdfjs-dist legacy build verified working on Vercel preview. 15MB upload accepted.
```

- [ ] **Step 7: Delete the spike route**

Delete `app/api/_pdf-spike/route.ts`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json docs/superpowers/specs/2026-05-18-pdf-upload-design.md
git rm app/api/_pdf-spike/route.ts
git commit -m "chore: add pdfjs-dist and verify Vercel runtime via spike"
```

---

## Task 2: PDF error classes

**Files:**
- Create: `lib/pdf/errors.ts`

- [ ] **Step 1: Write the error classes**

Create `lib/pdf/errors.ts`:

```ts
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
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
npx tsc --noEmit
```

Expected: no errors related to `lib/pdf/errors.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/pdf/errors.ts
git commit -m "feat(pdf): add typed error classes for extraction failures"
```

---

## Task 3: PDF extraction module

**Files:**
- Create: `lib/pdf/extractPdf.ts`

**Constants used in this module (define inline at top of file):**
- `MAX_PAGES = 30`
- `MIN_TOTAL_TEXT_CHARS = 100`

- [ ] **Step 1: Write `extractPdfText`**

Create `lib/pdf/extractPdf.ts`:

```ts
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
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
npx tsc --noEmit
```

Expected: no errors. If TS complains about missing types for `pdfjs-dist/legacy/build/pdf.mjs`, that's expected — the dynamic import is typed as `any` which is fine for our usage. Do NOT add `// @ts-ignore` unless the compiler actually fails.

- [ ] **Step 3: Commit**

```bash
git add lib/pdf/extractPdf.ts
git commit -m "feat(pdf): add extractPdfText using pdfjs-dist legacy build"
```

---

## Task 4: Manual verification script

**Why a script and not unit tests:** This repo has no test runner. The script gives reproducible verification we can re-run anytime. It also doubles as the test harness for Tasks 6 and 7.

**Files:**
- Create: `scripts/verify-pdf-extract.ts`
- Add: `tsx` as a devDependency

- [ ] **Step 1: Install `tsx`**

Run:
```bash
npm install --save-dev tsx
```

Expected: `package.json` gets `"tsx": "^4.x.x"` under `devDependencies`.

- [ ] **Step 2: Write the script**

Create `scripts/verify-pdf-extract.ts`:

```ts
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
```

- [ ] **Step 3: Smoke-test the script**

Use any small text PDF on disk. If you don't have one, ask the user to drop a sample into `scripts/fixtures/sample-text.pdf` (create the directory first).

```bash
mkdir -p scripts/fixtures
# user supplies scripts/fixtures/sample-text.pdf
npx tsx scripts/verify-pdf-extract.ts scripts/fixtures/sample-text.pdf
```

Expected: prints page count, total chars > 0, and a readable first 500 chars in plain text.

- [ ] **Step 4: Add fixtures to .gitignore**

Append to the project `.gitignore` (create the entry if not present):
```
# Local PDF fixtures used for manual verification
/scripts/fixtures/
```

We don't commit user-supplied PDFs. If `.gitignore` already has the entry, skip.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/verify-pdf-extract.ts .gitignore
git commit -m "chore(pdf): add manual verification script and tsx devDep"
```

---

## Task 5: API route — PDF branch

**Files:**
- Modify: `app/api/knowledge/store/route.ts`

- [ ] **Step 1: Add `maxDuration` and a dispatch on extension**

Open `app/api/knowledge/store/route.ts`. At the top of the file (after the imports), add:

```ts
export const maxDuration = 300;
export const runtime = "nodejs";
```

Then update the imports section (currently lines 1-5) to also include the PDF helpers:

```ts
import { db } from "@/db/client";
import { knowledge_source } from "@/db/schema";
import { isAuthorized } from "@/lib/isAuthorized";
import { summarizeMarkdown } from "@/lib/openAI";
import { extractPdfText } from "@/lib/pdf/extractPdf";
import {
  PdfCorruptError,
  PdfEncryptedError,
  PdfImageOnlyError,
  PdfTooLargeError,
} from "@/lib/pdf/errors";
import { NextRequest, NextResponse } from "next/server";
```

- [ ] **Step 2: Replace the `if (type === "upload")` block with extension-aware dispatch**

The current block (lines 22-59 of the existing file) only handles CSV. Replace it entirely with:

```ts
      if (type === "upload") {
        const file = formData.get("file") as File;

        if (!file) {
          return NextResponse.json(
            { error: "No file provided" },
            { status: 400 }
          );
        }

        const fileName = file.name;
        const lowerName = fileName.toLowerCase();
        const isPdf =
          lowerName.endsWith(".pdf") || file.type === "application/pdf";
        const isCsv =
          lowerName.endsWith(".csv") || file.type === "text/csv";

        if (isPdf) {
          const buffer = Buffer.from(await file.arrayBuffer());

          let extracted: { text: string; pageCount: number };
          try {
            extracted = await extractPdfText(buffer);
          } catch (err) {
            if (err instanceof PdfEncryptedError) {
              return NextResponse.json(
                {
                  error:
                    "This PDF is password-protected. Please upload an unlocked version.",
                },
                { status: 400 }
              );
            }
            if (err instanceof PdfTooLargeError) {
              return NextResponse.json(
                {
                  error: `PDF has ${err.pageCount} pages. Maximum supported is 30 pages — please split the file.`,
                },
                { status: 400 }
              );
            }
            if (err instanceof PdfImageOnlyError) {
              return NextResponse.json(
                {
                  error:
                    "This PDF appears to be scanned or image-based. We can't extract text from it yet — please upload a text-based PDF.",
                },
                { status: 400 }
              );
            }
            if (err instanceof PdfCorruptError) {
              return NextResponse.json(
                { error: "Could not read this PDF. The file may be corrupted." },
                { status: 400 }
              );
            }
            throw err;
          }

          const content =
            extracted.text.length > 8000
              ? await summarizeMarkdown(extracted.text)
              : extracted.text;

          await db.insert(knowledge_source).values({
            user_email: user.email,
            type: "upload",
            name: fileName,
            status: "active",
            content,
            meta_data: JSON.stringify({
              fileName,
              fileSize: file.size,
              pageCount: extracted.pageCount,
              fileType: "pdf",
            }),
          });

          return NextResponse.json(
            { message: "PDF uploaded successfully" },
            { status: 200 }
          );
        }

        if (isCsv) {
          const fileContent = await file.text();
          const lines = fileContent.split("\n").filter((line) => line.trim());
          const headers = lines[0]?.split(",").map((h) => h.trim());
          const markdown = await summarizeMarkdown(fileContent);

          await db.insert(knowledge_source).values({
            user_email: user.email,
            type: "upload",
            name: fileName,
            status: "active",
            content: markdown,
            meta_data: JSON.stringify({
              fileName,
              fileSize: file.size,
              rowCount: lines.length - 1,
              headers,
              fileType: "csv",
            }),
          });

          return NextResponse.json(
            { message: "CSV file uploaded successfully" },
            { status: 200 }
          );
        }

        return NextResponse.json(
          { error: "Only CSV and PDF files are allowed" },
          { status: 400 }
        );
      }
```

Note: this block adds a `fileType` key to the CSV branch's `meta_data` (previously absent). That is intentional — both branches now record the file type for consistency.

- [ ] **Step 3: Verify it compiles**

Run:
```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Local smoke test — small text PDF**

```bash
npm run dev
```

In another terminal, get an auth cookie (the route uses `isAuthorized()`). The simplest path: log in to the dashboard at `http://localhost:3000/dashboard` in your browser, copy the `user_session` cookie value from devtools, then:

```bash
curl -X POST http://localhost:3000/api/knowledge/store \
  -H "Cookie: user_session=<paste-value>" \
  -F "type=upload" \
  -F "file=@scripts/fixtures/sample-text.pdf"
```

Expected: HTTP 200, body `{"message":"PDF uploaded successfully"}`. Open Drizzle Studio (`npm run db:studio`) → `knowledge_source` and confirm a new row exists with `type: "upload"`, the PDF's filename in `name`, plain text in `content`, and `meta_data` containing `pageCount` and `fileType: "pdf"`.

- [ ] **Step 5: Local smoke test — error paths**

Re-run the curl with each of these and confirm the response:

| File | Expected status | Expected message contains |
|---|---|---|
| A 31+ page PDF | 400 | `"30 pages"` |
| A password-protected PDF | 400 | `"password-protected"` |
| A renamed `.txt → .pdf` | 400 | `"corrupted"` |
| A scanned/image-only PDF | 400 | `"scanned or image-based"` |
| A `.docx` file | 400 | `"Only CSV and PDF files are allowed"` |

If you don't have one of these test fixtures, ask the user — they can drop fixtures into `scripts/fixtures/`.

- [ ] **Step 6: Local regression test — CSV still works**

```bash
curl -X POST http://localhost:3000/api/knowledge/store \
  -H "Cookie: user_session=<paste-value>" \
  -F "type=upload" \
  -F "file=@<path-to-some.csv>"
```

Expected: HTTP 200, `{"message":"CSV file uploaded successfully"}`, and a row appears in `knowledge_source` with `meta_data.rowCount` and `meta_data.headers` populated.

- [ ] **Step 7: Commit**

```bash
git add app/api/knowledge/store/route.ts
git commit -m "feat(api): accept PDF uploads in /api/knowledge/store"
```

---

## Task 6: Frontend — widen modal to accept PDFs

**Files:**
- Modify: `components/dashboard/knowledge/addKnowledgeModal.tsx`

- [ ] **Step 1: Update the upload tab content**

Open `components/dashboard/knowledge/addKnowledgeModal.tsx`. Find the `<TabsContent value="upload" ...>` block (currently lines 229-275). Replace its inner content with:

```tsx
            <TabsContent
              value="upload"
              className="mt-0 space-y-4 animate-in fade-in duration-300"
            >
              <input
                type="file"
                id="knowledge-file-input"
                accept=".csv,.pdf,text/csv,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;

                  // 15MB cap
                  if (file.size > 15 * 1024 * 1024) {
                    setError("File size must be less than 15MB");
                    return;
                  }

                  const lowerName = file.name.toLowerCase();
                  const isCsv =
                    lowerName.endsWith(".csv") || file.type === "text/csv";
                  const isPdf =
                    lowerName.endsWith(".pdf") ||
                    file.type === "application/pdf";

                  if (!isCsv && !isPdf) {
                    setError("Only CSV and PDF files are allowed");
                    return;
                  }

                  setUploadedFile(file);
                  setError(null);
                }}
              />
              <div
                className="border-2 border-dashed border-white/10 rounded-xl h-60 flex flex-col items-center justify-center text-center p-6 hover:bg-white/2 transition-colors cursor-pointer"
                onClick={() => {
                  document.getElementById("knowledge-file-input")?.click();
                }}
              >
                <div className="w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
                  <Upload className="w-6 h-6 text-zinc-400" />
                </div>
                <p className="text-sm font-medium text-white">
                  {uploadedFile
                    ? uploadedFile.name
                    : "Click to upload or drag and drop"}
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  CSV or PDF (max 15MB)
                </p>
              </div>
            </TabsContent>
```

The changes vs. the current code:
- `id` renamed `csv-file-input` → `knowledge-file-input`.
- `accept` now `.csv,.pdf,text/csv,application/pdf`.
- Size cap `10 * 1024 * 1024` → `15 * 1024 * 1024`.
- File-type check now allows either CSV or PDF (extension OR MIME).
- Error messages updated.
- Helper line `"CSV (max 10MB)"` → `"CSV or PDF (max 15MB)"`.
- `getElementById("csv-file-input")` → `getElementById("knowledge-file-input")` in the click handler.

- [ ] **Step 2: Verify it compiles**

Run:
```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Manual UI test**

Run `npm run dev`. Log into the dashboard, open the Add Source modal, click the File Upload tab. Verify in this exact order:

1. The helper text reads `CSV or PDF (max 15MB)`.
2. Clicking the drop zone opens the file picker filtered to CSV/PDF.
3. Selecting a small text PDF (under 15MB) → no validation error, filename appears in the drop zone.
4. Click `Import Source` → spinner, then the modal closes (or whatever the parent does on success — do not change parent behavior).
5. The new source appears in the knowledge sources list.
6. Selecting an `.xlsx` or `.txt` file → error `"Only CSV and PDF files are allowed"` shown in the Alert.
7. Selecting a >15MB PDF → error `"File size must be less than 15MB"`.
8. Selecting a CSV → no validation error, imports successfully (regression check).

If any of these fail, fix before proceeding. Do not claim the UI works without confirming each step in the browser.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/knowledge/addKnowledgeModal.tsx
git commit -m "feat(ui): accept PDF uploads in Add Source modal"
```

---

## Task 7: End-to-end verification on Vercel preview

**Why this is its own task:** Local works ≠ Vercel works. We confirmed extraction in Task 1 but not the full UI → API → DB path under serverless constraints (cold starts, 15MB body, 300s timeout).

**Files:** none modified.

- [ ] **Step 1: Push and wait for Vercel preview**

The user pushes the branch. Wait for the Vercel preview URL.

- [ ] **Step 2: Run the spec's full test matrix on the preview URL**

Log into the deployed dashboard preview and walk through these in the browser:

1. **Small text PDF (~2 pages):** uploads, appears in source list, open chat and ask a specific question that's answerable from the PDF — bot answers using the content.
2. **Long text PDF (~20 pages):** uploads, appears in source list, ask a high-level question — bot answers (will be from the summarized content).
3. **31-page PDF:** import fails with the precise message `"PDF has 31 pages. Maximum supported is 30 pages — please split the file."` shown in the modal.
4. **16MB PDF:** import fails client-side with `"File size must be less than 15MB"` (file-picker stage, never hits server).
5. **Scanned/image-only PDF:** import fails with `"This PDF appears to be scanned or image-based..."`.
6. **Password-protected PDF:** import fails with `"This PDF is password-protected..."`.
7. **`.txt` renamed to `.pdf`:** import fails with `"Could not read this PDF..."`.
8. **CSV regression:** existing CSV upload still works at the new cap.

For each failure case, also check the Vercel function logs to confirm the underlying error was logged via `console.error` (existing convention) and not lost.

- [ ] **Step 3: If any case fails, file a follow-up note**

If a case fails, do not "fix and ship" silently. Document the failure in a brief note appended to the spec under a new "Known issues" heading and bring it back to the user. Some failures (e.g., 12MB PDF rejected by Vercel body limit) are environmental and need a product decision, not a code fix.

- [ ] **Step 4: Final commit (if any verification-driven fixes were needed)**

If Task 7 surfaced bugs, fix them with their own commits using the `fix(pdf):` or `fix(ui):` prefix as appropriate. If everything passed, no commit needed for this task.

---

## Self-review notes

- Spec coverage: each spec section maps to a task. End-to-end flow → Tasks 5+6+7. Component breakdown → Tasks 2, 3, 5, 6. Data flow → Task 3. Error handling table → Task 5 (server messages) + Task 6 (client messages). Storage model → Task 5. Testing → Tasks 1 (spike), 4 (script), 5 step 4-6 (API curl), 6 step 3 (UI), 7 (Vercel E2E).
- Constants `MAX_PAGES = 30` and `MIN_TOTAL_TEXT_CHARS = 100` live only in `lib/pdf/extractPdf.ts` — single source of truth. The route handler doesn't need them; it only handles the typed errors.
- `summarizeMarkdown` threshold of 8000 chars matches the existing `text` branch's 500-char threshold pattern (conditional summarization). The spec calls for 8000 specifically for PDFs because PDF text can be much longer than typed text input; this is intentional and noted in the spec.
- Function name `extractPdfText` is used identically across Tasks 3, 4, 5 — verified.
- No placeholders, no "TBD", no references to undefined symbols.
- The plan does not introduce a test runner; verification is via the script + manual UI testing, matching the project's existing convention.
