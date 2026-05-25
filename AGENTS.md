# AGENTS.md

## Commands

- Use npm; `package-lock.json` is the lockfile.
- `npm run dev` starts the Next.js dev server at `http://localhost:3000`.
- `npm run build` is the production build; `npm run start` serves that build.
- Database commands are `npm run db:generate`, `npm run db:migrate`, `npm run db:push`, and `npm run db:studio`; migrations are generated from `db/schema.ts` into `drizzle/`.
- There is no `test`, `lint`, or `typecheck` script. Use focused checks explicitly, for example `npx tsc --noEmit`; ESLint packages are installed but no repo lint config/script is present.
- For PDF extraction debugging, run `npx tsx scripts/verify-pdf-extract.ts <pdf-path>`.

## Environment

- `.env*` is gitignored; never commit secrets.
- Required runtime env is accessed directly with `process.env.X!`, so missing values often fail at request time, not boot.
- Core env: `DATABASE_URL`, `SCALEKIT_ENVIRONMENT_URL`, `SCALEKIT_CLIENT_ID`, `SCALEKIT_CLIENT_SECRET`, `SCALEKIT_REDIRECT_URI`, `SCALEKIT_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `JWT_SECRET`, `FIRECRAWL_API_KEY`.
- Current code also uses `COHERE_API_KEY` for reranking, `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` for voice widget sessions, optional `OPENAI_BASE_URL`, and `NEXT_PUBLIC_WEBSITE_URI` for generated embed snippets.
- `@vercel/blob` stores uploaded originals in `lib/rag/blob.ts`; ensure the deployment/local environment has the Vercel Blob credentials it expects.

## Architecture

- This is a single Next.js 16 App Router app with React 19, TypeScript strict, Tailwind v4, and shadcn/ui `new-york`; `@/*` resolves to the repo root.
- Main surfaces: marketing at `app/page.tsx`, dashboard under `app/dashboard/**`, iframe widget at `app/embed/page.tsx`, and route handlers under `app/api/**`.
- Dashboard auth is Scalekit OIDC. Server code should read the `user_session` cookie through `lib/isAuthorized.ts`; dashboard layout visibility is gated by a separate `metadata` cookie.
- Public widget users do not sign in. `/api/widget/session` issues a 2h HS256 JWT carrying `widgetId`, `ownerEmail`, and `sessionId`; widget config/chat/voice routes validate that token.
- Widget CORS is intentionally permissive for cross-origin embedding; do not tighten it casually.

## Data And RAG

- Drizzle uses Neon HTTP (`db/client.ts`) with schema in `db/schema.ts`; ids and timestamps are text columns with SQL defaults.
- Do not assume the old single-blob RAG flow. Current ingestion writes `knowledge_source` plus chunk rows in `knowledge_chunk`, stores originals in Vercel Blob, embeds chunks with OpenAI `text-embedding-3-small`, and tracks `extraction_status`.
- Retrieval in `lib/rag/retrieve.ts` combines pgvector HNSW search with Postgres full-text search, fuses candidates with RRF, then reranks with Cohere `rerank-v3.5`.
- Migration `drizzle/0010_breezy_stick.sql` creates the `vector` extension, `knowledge_chunk`, generated `fts`, indexes, and a cascade foreign key to `knowledge_source`; keep schema/migrations aligned when changing RAG tables.
- `/api/chat/public` persists conversations/messages by widget JWT `sessionId`, retrieves top context chunks from selected section `source_ids`, summarizes history over 6000 tokens, and answers with short cited responses.

## Project Conventions

- shadcn/ui config lives in `components.json`; add components with `npx shadcn@latest add <component>` and keep aliases under `@/components`, `@/components/ui`, `@/lib/utils`, and `@/hooks`.
- `lib/openAI.ts` currently uses a custom HTTPS agent with `rejectUnauthorized: false`; treat that as a development-only gotcha before production changes.
- Many API routes return generic 500s and log details with `console.error`; inspect server logs when debugging API failures.
