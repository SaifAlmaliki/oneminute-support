# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Next.js dev server (http://localhost:3000)
npm run build          # Production build
npm run start          # Run production build

npm run db:generate    # Generate a new Drizzle migration from db/schema.ts
npm run db:migrate     # Apply pending migrations to DATABASE_URL
npm run db:push        # Push schema directly (no migration file) — use sparingly
npm run db:studio      # Open Drizzle Studio against DATABASE_URL
```

There is no configured test runner and no `lint` script. ESLint (`eslint-config-next`) is installed but must be run via `npx next lint`.

## Required environment

All declared in code via `process.env.X!` — missing values throw at request time, not at boot:

- `DATABASE_URL` — Neon serverless Postgres connection string (`db/client.ts`, `drizzle.config.ts`)
- `SCALEKIT_ENVIRONMENT_URL`, `SCALEKIT_CLIENT_ID`, `SCALEKIT_CLIENT_SECRET`, `SCALEKIT_REDIRECT_URI`, `SCALEKIT_WEBHOOK_SECRET` — Scalekit SSO + webhook (`lib/scalekit.ts`, `app/api/auth/**`, `app/api/webhook/scalekit/route.ts`)
- `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` — chat + summarization (`lib/openAI.ts`)
- `JWT_SECRET` — HMAC secret for embeddable widget session tokens (`app/api/widget/**`, `app/api/chat/public/route.ts`)
- `FIRECRAWL_API_KEY` — website-scraping API used by knowledge ingestion (`app/api/knowledge/store/route.ts`)

## Architecture

Single Next.js 16 App Router app (React 19, TypeScript strict, Tailwind v4, shadcn/ui "new-york"). Path alias `@/*` resolves to the repo root. Routes split into three top-level surfaces:

1. **Marketing site** — `app/page.tsx` composes `components/landing/*`.
2. **Authenticated dashboard** — `app/dashboard/**`, gated by a `metadata` cookie at the layout level (`app/dashboard/layout.tsx`); the sidebar only renders when the user has completed onboarding.
3. **Embeddable widget** — `app/embed/page.tsx` is loaded inside an iframe on third-party sites and `postMessage`s back to the parent for resizing.

### Auth model (two distinct mechanisms)

- **Dashboard users** authenticate via Scalekit OIDC. `/api/auth` builds the auth URL; `/api/auth/callback` validates the ID token, upserts a `user` row, and writes a `user_session` cookie containing `{ email, organization_id }` as JSON. `lib/isAuthorized.ts` (a `"use server"` function) is the canonical way to read it from server code; client code uses the `useUser()` hook in `hooks/useUser.ts`. Team-membership webhooks land at `/api/webhook/scalekit`.
- **Public widget visitors** never sign in. `/api/widget/session` issues a short-lived (2h) `jose` HS256 JWT carrying `{ widgetId, ownerEmail, sessionId }`. The embed UI fetches `/api/widget/config?token=...` to load branding + sections, then posts messages to `/api/chat/public` with `Authorization: Bearer <jwt>`. The widget endpoints set permissive CORS — that is intentional and required for cross-origin embedding.

### Data layer

Drizzle ORM over `@neondatabase/serverless` HTTP driver (`db/client.ts`). Schema in `db/schema.ts`; migrations in `drizzle/`. Key conventions to preserve when extending:

- All ids are `text` with `gen_random_uuid()` defaults; all timestamps are stored as `text` with `now()` defaults (not `timestamp` columns).
- There are **no foreign keys**. Tables are joined by string fields: most user-owned data keys off `user_email`, conversations key off `chatbot_id`, team membership keys off `organization_id`. Don't assume referential integrity at the DB level.
- The `chatBotMetadata` row's `id` doubles as the public `widget_id` exposed to embeds.

### Chat / RAG flow

`/api/chat/public` is the runtime path. It does **not** use a vector store. Instead:

1. Caller sends `messages[]` plus `knowledge_source_ids[]` (the IDs of `sections.source_ids` selected in the dashboard).
2. Server fetches `knowledge_source.content` for those IDs and concatenates them as the `context` block in the system prompt.
3. If `countConversationTokens(messages) > 6000` (via `lib/countConversationTokens.ts`, gpt-4o-mini tokenizer), the older messages (everything except the last 10) are summarized via `summarizeConversation` and prepended to context; only the last 10 messages are sent to the model.
4. Conversation + each user/assistant turn is persisted to `conversation` / `messages` keyed by the JWT's `sessionId`.

### Knowledge ingestion

`/api/knowledge/store` accepts three `type` values: `website` (scraped through Firecrawl → markdown → summarized via `summarizeMarkdown`), `text` (summarized only if length > 500), and `upload` (multipart CSV; the whole file body is summarized). All paths produce a single dense plaintext blob stored in `knowledge_source.content` — there is no chunking and no embeddings.

### Notable gotchas

- `lib/openAI.ts` constructs an `https.Agent` with `rejectUnauthorized: false` and routes `fetch` through it. The comment flags this as dev-only; do not ship it as-is to production without flipping it.
- Several routes catch errors and return generic 500s while `console.error`-ing the real cause — when debugging an API failure, check server logs rather than the response body.
- Adding a shadcn/ui component: registry config lives in `components.json` (`@/components/ui`, `@/lib/utils`, `@/hooks` aliases). Use `npx shadcn@latest add <component>`.
