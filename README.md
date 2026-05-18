# OneMinute Support

A Next.js 16 (App Router, React 19) application that lets businesses ingest their docs/website/CSVs and embed an AI customer-support chat widget on third-party sites. Built with Drizzle ORM on Neon Postgres, Scalekit OIDC for dashboard SSO, OpenAI for chat + summarization, and Firecrawl for website scraping.

## Stack

- **Framework**: Next.js 16, React 19, TypeScript (strict)
- **Styling**: Tailwind CSS v4, shadcn/ui (style: `new-york`), Radix primitives
- **Database**: Neon serverless Postgres via Drizzle ORM (`drizzle-orm/neon-http`)
- **Auth**: Scalekit OIDC for dashboard users; signed JWT (`jose`, HS256) for public widget sessions
- **AI**: OpenAI (`gpt-4o` for chat, `gpt-4o-mini` for summarization), `js-tiktoken` for token counting
- **Scraping**: Firecrawl (`api.firecrawl.dev`) for website knowledge ingestion

## Getting started

```bash
npm install
# create .env (see "Environment variables" below)
npm run db:migrate     # apply migrations to DATABASE_URL
npm run dev            # http://localhost:3000
```

## Scripts

```bash
npm run dev            # Next.js dev server
npm run build          # Production build
npm run start          # Run production build

npm run db:generate    # Generate a new Drizzle migration from db/schema.ts
npm run db:migrate     # Apply pending migrations
npm run db:push        # Push schema directly without a migration file (use sparingly)
npm run db:studio      # Open Drizzle Studio
```

## Environment variables

Create a `.env` file in the repo root. All variables are read via `process.env.X!` — missing values throw at request time, not at boot.

```env
# --- Database (required) ---
# Neon serverless Postgres connection string. Used by db/client.ts and drizzle.config.ts.
DATABASE_URL=postgres://USER:PASSWORD@HOST/DB?sslmode=require

# --- Scalekit OIDC (required for dashboard auth + team webhooks) ---
# From your Scalekit dashboard. SCALEKIT_REDIRECT_URI must point at /api/auth/callback.
SCALEKIT_ENVIRONMENT_URL=https://your-env.scalekit.dev
SCALEKIT_CLIENT_ID=skc_...
SCALEKIT_CLIENT_SECRET=...
SCALEKIT_REDIRECT_URI=http://localhost:3000/api/auth/callback
SCALEKIT_WEBHOOK_SECRET=whsec_...

# --- OpenAI (required for chat + summarization) ---
OPENAI_API_KEY=sk-...
# Optional: only set if you proxy OpenAI through a custom gateway.
# OPENAI_BASE_URL=https://your-proxy.example.com/v1

# --- Widget JWT (required for the embeddable chat widget) ---
# Any sufficiently long random string; used to sign 2h widget session tokens.
JWT_SECRET=replace-with-a-long-random-string

# --- Firecrawl (required for "website" knowledge sources) ---
FIRECRAWL_API_KEY=fc-...
```

Where each is consumed:

| Variable | Used in |
|---|---|
| `DATABASE_URL` | `db/client.ts`, `drizzle.config.ts` |
| `SCALEKIT_*` | `lib/scalekit.ts`, `app/api/auth/**`, `app/api/webhook/scalekit/route.ts` |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | `lib/openAI.ts` |
| `JWT_SECRET` | `app/api/widget/session/route.ts`, `app/api/widget/config/route.ts`, `app/api/chat/public/route.ts` |
| `FIRECRAWL_API_KEY` | `app/api/knowledge/store/route.ts` |

`.env*` is gitignored — never commit secrets.

## Project layout

```
app/
  page.tsx              Marketing landing page (composes components/landing/*)
  layout.tsx            Root layout
  dashboard/            Authenticated dashboard (knowledge / sections / chatbot / conversations / settings)
  embed/                Embeddable iframe widget (postMessage-based resize)
  api/                  Route handlers
    auth/               Scalekit OIDC login + callback
    webhook/scalekit/   Scalekit webhook receiver (signature-verified)
    widget/             session (issues JWT) + config (returns branding + sections)
    chat/public/        Public chat endpoint for the embed widget (JWT-gated)
    knowledge/          fetch + store (website via Firecrawl, text, CSV upload)
    section/            create / fetch / delete
    metadata/           Onboarding metadata fetch + store
    organization/       Organization fetch
    team/               add + fetch (Scalekit-managed members)
    chatbot/metadata/   fetch + update
    conversations/      list + per-id messages/reply
    overview/           Dashboard summary stats
components/
  landing/              Marketing-page sections
  dashboard/            Sidebar + dashboard widgets (chatbot, sections, knowledge, settings)
  ui/                   shadcn/ui components
db/
  client.ts             Drizzle + Neon HTTP client
  schema.ts             Tables: user, metadata, knowledge_source, sections, chatBotMetadata,
                        teamMembers, conversation, messages, widgets
drizzle/                Generated SQL migrations
hooks/                  useUser, use-mobile
lib/
  openAI.ts             OpenAI client + summarizeMarkdown / summarizeConversation
  scalekit.ts           Scalekit SDK client
  isAuthorized.ts       "use server" — reads user_session cookie
  countConversationTokens.ts
  utils.ts              cn() Tailwind class merger
@types/types.d.ts       Global UI types (SourceType, Tone, Section, etc.)
```

## Architecture notes

- **Two auth systems.** Dashboard users sign in via Scalekit OIDC; the callback writes a `user_session` cookie containing `{ email, organization_id }` JSON. Embeddable widget visitors never sign in — `/api/widget/session` issues a 2h `jose` HS256 JWT bound to a `widgetId` + `sessionId`, and the public chat endpoint validates it.
- **No foreign keys.** Tables join by string fields (`user_email`, `chatbot_id`, `organization_id`). All ids are `text` with `gen_random_uuid()` defaults, all timestamps are `text` with `now()` defaults.
- **No vector store.** RAG is done by concatenating selected `knowledge_source.content` blobs into the system prompt. When the conversation exceeds 6000 tokens, older messages (everything except the last 10) are summarized and prepended to context.
- **Knowledge ingestion** summarizes everything aggressively into a single dense plaintext blob via `summarizeMarkdown`. Websites are fetched through Firecrawl (markdown format); CSV uploads have their full body summarized; short text snippets (<500 chars) are stored as-is.
- **Widget CORS** is intentionally permissive on `/api/widget/session` and the embed flow — required for cross-origin iframe embedding.

## Adding shadcn/ui components

Registry config is in `components.json`. Aliases: `@/components`, `@/components/ui`, `@/lib/utils`, `@/hooks`.

```bash
npx shadcn@latest add <component>
```
