# Firecrawl Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ZenRows with Firecrawl as the website scraper in `app/api/knowledge/store/route.ts`, and remove ZenRows from the codebase, env, and docs.

**Architecture:** Single fetch-call swap. The current `type === "website"` branch builds a ZenRows URL and GETs it; we replace that with a `POST` to `https://api.firecrawl.dev/v2/scrape`, parse the JSON response, return a 502 on failure, and feed `data.markdown` into the existing `summarizeMarkdown` call. No new dependencies; no abstraction layer.

**Tech Stack:** Next.js 16 App Router route handler (`route.ts`), TypeScript strict, raw `fetch` against Firecrawl v2 REST API. No test runner is configured in this repo, so verification is manual via `npm run dev`.

**Reference spec:** `docs/superpowers/specs/2026-05-18-firecrawl-swap-design.md`

**A note on commits:** The repo owner prefers to run `git add` / `git commit` themselves (auto-memory rule). The commit steps below describe what to commit and the suggested message; the human or executing agent should run them only with explicit approval.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `app/api/knowledge/store/route.ts` | **Modify** lines ~64–87 (the `type === "website"` branch) | Single behavioral change: scrape via Firecrawl instead of ZenRows |
| `CLAUDE.md` | **Modify** the "Required environment" section | Replace `ZENROWS_API_KEY` line with `FIRECRAWL_API_KEY` |
| `README.md` | **Modify** the "Stack" bullet, the env-var block, and the consumption table | Replace ZenRows references with Firecrawl |
| `.env` | **Manual edit by repo owner** | Remove `ZENROWS_API_KEY=...` |
| `package.json` | **No change** | No new dependency — using raw `fetch` |
| `db/schema.ts` | **No change** | Storage shape unchanged |

---

## Task 1: Replace ZenRows scrape with Firecrawl in `route.ts`

**Files:**
- Modify: `app/api/knowledge/store/route.ts:64-87`

**Context for the engineer:**
- The route handler returns `NextResponse`. Existing convention: catch errors, return generic 500 outside, but specific 4xx/5xx for known failure modes (e.g. the existing 502 path).
- The route runs in a Next.js App Router server context and uses `process.env.X!` (non-null assertion) — that's the project convention; missing env throws at request time. Don't add boot-time validation.
- The Firecrawl v2 success response shape is `{ success: true, data: { markdown: string, metadata: {...} } }`. Failure: `{ success: false, error: string }` (and/or non-2xx HTTP status).
- The downstream `summarizeMarkdown(...)` and `db.insert(knowledge_source).values({...})` calls stay exactly as-is.
- The current `if (!res.text)` check is dead code (`res.text` is always a function reference) — it is being replaced, not preserved.

- [ ] **Step 1: Read the current file to confirm line numbers**

Run:
```bash
sed -n '60,100p' app/api/knowledge/store/route.ts
```
Expected: see the current ZenRows block from line 64 (`if (type === "website") {`) to roughly line 98 (the `db.insert` call closing).

- [ ] **Step 2: Replace the ZenRows block with the Firecrawl call**

In `app/api/knowledge/store/route.ts`, replace this block:

```ts
    if (type === "website") {
      const zenUrl = new URL("https://api.zenrows.com/v1/");
      zenUrl.searchParams.set("apikey", process.env.ZENROWS_API_KEY!);
      zenUrl.searchParams.set("url", body.url);
      zenUrl.searchParams.set("response_type", "markdown");

      const res = await fetch(zenUrl.toString(), {
        headers: {
          "User-Agent": "OneMinuteSupportBot/1.0",
        },
      });

      const html = await res.text();

      if (!res.text) {
        return NextResponse.json(
          {
            error: "ZenRows request failed",
            status: res.status,
            body: html.slice(0, 500),
          },
          { status: 502 }
        );
      }

      const markdown = await summarizeMarkdown(html);

      await db.insert(knowledge_source).values({
        user_email: user.email,
        type: "website",
        name: body.url,
        status: "active",
        source_url: body.url,
        content: markdown,
      });
    } else if (type === "text") {
```

…with this block:

```ts
    if (type === "website") {
      const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY!}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: body.url,
          formats: ["markdown"],
        }),
      });

      const json = (await res.json().catch(() => null)) as
        | { success: true; data: { markdown: string } }
        | { success: false; error?: string }
        | null;

      if (!res.ok || !json || json.success !== true) {
        return NextResponse.json(
          {
            error: "Firecrawl request failed",
            status: res.status,
            message:
              (json && "error" in json && json.error) ||
              "Unknown Firecrawl error",
          },
          { status: 502 }
        );
      }

      const markdown = await summarizeMarkdown(json.data.markdown);

      await db.insert(knowledge_source).values({
        user_email: user.email,
        type: "website",
        name: body.url,
        status: "active",
        source_url: body.url,
        content: markdown,
      });
    } else if (type === "text") {
```

Notes:
- The `db.insert(...)` call is unchanged.
- `summarizeMarkdown` import on line 4 is unchanged (still used).
- The `try/catch` wrapping the whole route and the `console.error("Error in knowledge store:", error)` log are unchanged — that matches the project convention from `CLAUDE.md` ("routes catch errors and return generic 500s while `console.error`-ing the real cause").

- [ ] **Step 3: Type-check the change**

Run:
```bash
npx tsc --noEmit
```
Expected: clean exit. If it fails, the most likely cause is the discriminated-union narrowing on `json` — verify the type annotation matches exactly what's shown above.

- [ ] **Step 4: Build to make sure Next.js still compiles the route**

Run:
```bash
npm run build
```
Expected: build succeeds. The `/api/knowledge/store` route shows up in the route table without errors.

- [ ] **Step 5: Manual verification — happy path**

There is no automated test runner. Verify manually:

1. Run `npm run dev`.
2. Sign in to the dashboard.
3. From the Knowledge page, add a new website source pointing at a real, simple URL (e.g. `https://example.com` or a known marketing page).
4. Confirm the request returns 200 and the new row appears in the Knowledge list.
5. Optionally, open Drizzle Studio (`npm run db:studio`) and confirm a row in `knowledge_source` with `type='website'`, the URL in `source_url`, and non-empty `content`.

Expected: 200 response, row created, `content` is a non-empty summarized markdown blob.

- [ ] **Step 6: Manual verification — error path**

With `npm run dev` still running, try adding a website source with a clearly-bad URL (e.g. `https://this-domain-definitely-does-not-exist-12345.invalid`).

Expected: the API returns a 502 with body shape `{ error: "Firecrawl request failed", status: <number>, message: <string> }`. The `message` should be informative (Firecrawl's error string) rather than `"Unknown Firecrawl error"` for normal failures. Server logs should NOT show an uncaught exception — the failure should be the explicit 502 path.

- [ ] **Step 7: Commit (with explicit approval from repo owner)**

```bash
git add app/api/knowledge/store/route.ts
git commit -m "feat: scrape websites with Firecrawl instead of ZenRows"
```

---

## Task 2: Update documentation

**Files:**
- Modify: `CLAUDE.md` (the "Required environment" section)
- Modify: `README.md` (the "Stack" bullet, the env-var section, and the consumption table)

- [ ] **Step 1: Update `CLAUDE.md` — replace the ZenRows env var line**

In `CLAUDE.md`, find this line:

```markdown
- `ZENROWS_API_KEY` — website-scraping proxy used by knowledge ingestion (`app/api/knowledge/store/route.ts`)
```

Replace it with:

```markdown
- `FIRECRAWL_API_KEY` — website-scraping API used by knowledge ingestion (`app/api/knowledge/store/route.ts`)
```

- [ ] **Step 2: Update `CLAUDE.md` — fix the knowledge-ingestion architecture note**

In `CLAUDE.md`, find this line in the "Knowledge ingestion" subsection:

```markdown
`/api/knowledge/store` accepts three `type` values: `website` (scraped through ZenRows → markdown → summarized via `summarizeMarkdown`), `text` (summarized only if length > 500), and `upload` (multipart CSV; the whole file body is summarized). All paths produce a single dense plaintext blob stored in `knowledge_source.content` — there is no chunking and no embeddings.
```

Replace `scraped through ZenRows` with `scraped through Firecrawl`. The rest of the sentence stays the same.

- [ ] **Step 3: Update `README.md` — Stack bullet**

In `README.md`, find:

```markdown
- **Scraping**: ZenRows (`api.zenrows.com`) for website knowledge ingestion
```

Replace with:

```markdown
- **Scraping**: Firecrawl (`api.firecrawl.dev`) for website knowledge ingestion
```

- [ ] **Step 4: Update `README.md` — first-paragraph stack mention**

In `README.md`, the very first paragraph reads:

```markdown
A Next.js 16 (App Router, React 19) application that lets businesses ingest their docs/website/CSVs and embed an AI customer-support chat widget on third-party sites. Built with Drizzle ORM on Neon Postgres, Scalekit OIDC for dashboard SSO, OpenAI for chat + summarization, and ZenRows for website scraping.
```

Change `ZenRows` to `Firecrawl`:

```markdown
A Next.js 16 (App Router, React 19) application that lets businesses ingest their docs/website/CSVs and embed an AI customer-support chat widget on third-party sites. Built with Drizzle ORM on Neon Postgres, Scalekit OIDC for dashboard SSO, OpenAI for chat + summarization, and Firecrawl for website scraping.
```

- [ ] **Step 5: Update `README.md` — env-var block**

In the `.env` example block in `README.md`, find:

```env
# --- ZenRows (required for "website" knowledge sources) ---
ZENROWS_API_KEY=...
```

Replace with:

```env
# --- Firecrawl (required for "website" knowledge sources) ---
FIRECRAWL_API_KEY=fc-...
```

- [ ] **Step 6: Update `README.md` — consumption table**

In the "Where each is consumed" table, find:

```markdown
| `ZENROWS_API_KEY` | `app/api/knowledge/store/route.ts` |
```

Replace with:

```markdown
| `FIRECRAWL_API_KEY` | `app/api/knowledge/store/route.ts` |
```

- [ ] **Step 7: Update `README.md` — knowledge-ingestion architecture note**

In `README.md`, find the architecture note:

```markdown
- **Knowledge ingestion** summarizes everything aggressively into a single dense plaintext blob via `summarizeMarkdown`. Websites are fetched through ZenRows (markdown response type); CSV uploads have their full body summarized; short text snippets (<500 chars) are stored as-is.
```

Change `ZenRows (markdown response type)` to `Firecrawl (markdown format)`:

```markdown
- **Knowledge ingestion** summarizes everything aggressively into a single dense plaintext blob via `summarizeMarkdown`. Websites are fetched through Firecrawl (markdown format); CSV uploads have their full body summarized; short text snippets (<500 chars) are stored as-is.
```

- [ ] **Step 8: Update `README.md` — project-layout comment**

In the `Project layout` code block, find:

```
    knowledge/          fetch + store (website via ZenRows, text, CSV upload)
```

Replace with:

```
    knowledge/          fetch + store (website via Firecrawl, text, CSV upload)
```

- [ ] **Step 9: Verify no stray ZenRows references remain**

Run:
```bash
grep -i "zenrows" -r --include="*.md" --include="*.ts" --include="*.tsx" --include="*.json" .
```
Expected: no matches anywhere in tracked files. If anything matches outside of `node_modules`, fix it before committing.

- [ ] **Step 10: Commit (with explicit approval from repo owner)**

```bash
git add CLAUDE.md README.md
git commit -m "docs: replace ZenRows references with Firecrawl"
```

---

## Task 3: Manual `.env` cleanup (repo owner action)

**Files:**
- Modify: `.env` (gitignored — the repo owner edits this directly)

This task is not executed by an agent — it's a heads-up for the repo owner.

- [ ] **Step 1: Remove the ZenRows key from `.env`**

Open `.env` and delete the line:

```
ZENROWS_API_KEY=...
```

- [ ] **Step 2: Confirm `FIRECRAWL_API_KEY` is set**

Run:
```bash
grep -E "^(FIRECRAWL|ZENROWS)_API_KEY=" .env
```
Expected: exactly one match — the `FIRECRAWL_API_KEY` line. No `ZENROWS_API_KEY` line.

- [ ] **Step 3: Restart the dev server**

If `npm run dev` is running, stop and restart it so the new env is picked up.

- [ ] **Step 4: Re-run the happy-path verification from Task 1, Step 5**

Confirm a website source still ingests successfully end-to-end after `ZENROWS_API_KEY` is gone. (If something still references the old key, this is where you'd find out.)

---

## Self-review (completed)

- **Spec coverage:** All four spec change-list items mapped to tasks — route.ts swap → Task 1; CLAUDE.md → Task 2 Steps 1–2; README.md → Task 2 Steps 3–8; `.env` → Task 3. Spec's "no SDK / no abstraction / no fallback" non-goals are honored (no `npm install`, no new files).
- **Placeholder scan:** No TBDs, no "add appropriate error handling", no vague test instructions. Every code step has full code; every command step has the exact command.
- **Type consistency:** `json` is annotated as a discriminated union in Task 1; the `json.success !== true` narrowing and `json.data.markdown` access are consistent with that union. The `summarizeMarkdown` and `db.insert(knowledge_source).values(...)` calls use the same signatures already in the file (verified against the read of `route.ts`).
