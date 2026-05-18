# Voice Chat via ElevenLabs Conversational AI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a voice-chat mode to the embeddable widget alongside the existing text chat, using ElevenLabs Conversational AI. Owners pick the mode (`text` / `voice` / `both`) from the dashboard. Voice transcripts persist into the same `conversation` / `messages` tables as text, so they appear in the existing Conversations page.

**Architecture:** One shared ElevenLabs agent, configured manually in their dashboard. Three new server endpoints (`voice-session`, `knowledge-search`, `voice-transcript`). Tool-callback pattern: when the agent needs context, it calls our server. The widget owns the WebSocket to ElevenLabs and pushes finalized transcripts back to us.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Drizzle ORM (Neon Postgres), `jose` (JWT/HMAC), ElevenLabs Conversational AI Web SDK (`@elevenlabs/client`).

**Spec:** `docs/superpowers/specs/2026-05-18-voice-chat-elevenlabs-design.md`

**User commit policy:** The user pushes to GitHub themselves. **Do NOT run `git commit` or `git push`.** Each "Commit" step in this plan is an instruction to the user — surface it as text saying "you can commit now with: ...", do not invoke git.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `db/schema.ts` | modify | Add `mode` to `chatBotMetadata`, `channel` to `conversation` |
| `drizzle/<generated>.sql` | create (generated) | Migration for the two new columns |
| `lib/voiceToken.ts` | create | Mint/verify per-call HMAC voice tokens (jose, HS256, 15 min) |
| `lib/elevenlabs.ts` | create | Thin server-side client for ElevenLabs REST (get-signed-url) |
| `app/api/widget/config/route.ts` | modify | Return `metadata.mode` in payload |
| `app/api/widget/voice-session/route.ts` | create | Mint signed URL + voice token; section auth + mode gate |
| `app/api/widget/knowledge-search/route.ts` | create | Tool callback: verify voice token, return concatenated knowledge content |
| `app/api/widget/voice-transcript/route.ts` | create | Persist finalized voice turns into `conversation` / `messages` |
| `app/api/chatbot/metadata/update/route.ts` | modify | Accept optional `mode` field |
| `components/dashboard/chatbot/modeConfig.tsx` | create | Dashboard UI for picking text/voice/both |
| `app/dashboard/chatbot/page.tsx` | modify | Wire `mode` into save flow + render `<ModeConfig />` |
| `app/embed/_components/TextChat.tsx` | create | Extracted from current `app/embed/page.tsx` (no logic change) |
| `app/embed/_components/VoiceChat.tsx` | create | New voice UI (idle / connected / error states) |
| `app/embed/_components/ModeToggle.tsx` | create | "💬 Chat / 🎙️ Talk" tab toggle, used only when `mode === "both"` |
| `app/embed/page.tsx` | modify | Becomes the bubble shell; routes to `TextChat` / `VoiceChat` based on mode |
| `app/api/conversations/route.ts` | modify | Return `channel` per conversation |
| `app/dashboard/conversations/page.tsx` | modify | Show 💬/🎤 badge per row |
| `public/widget.js` | modify | Add `iframe.allow = "microphone"` |

---

## Pre-flight (one-time, do once before starting tasks)

These are user actions, not code tasks. **List them at the top of the work and confirm with the user before starting Task 1.**

1. **Configure the ElevenLabs agent** in the ElevenLabs dashboard:
   - Voice: pick one (this is your one shared voice for v1).
   - System prompt (paste in their dashboard):
     ```
     You are Sarah, a friendly customer support specialist on a phone-style call.
     Keep replies extremely short (1–2 sentences) and conversational.
     Mirror the caller's brevity. Never dump information.
     If you don't know the answer or the caller is unhappy, ask:
     "Would you like me to create a support ticket?"
     If they say "yes", reply: "I have created a support ticket. Our specialist team will follow up."
     ```
   - Add **one webhook tool**: name `search_knowledge`, description "Fetch the user's selected knowledge base for the current section", parameter `query: string` (required, "what the caller is asking about"). URL: `https://<your-domain>/api/widget/knowledge-search`. Method: `POST`. Custom header: `X-Voice-Token: {{voice_token}}` (the agent will substitute the dynamic variable).
   - Add **dynamic variable** `voice_token` (string) so it can be passed in via the get-signed-URL call and forwarded to the tool.
2. **Add env vars locally and on Vercel:**
   - `ELEVENLABS_API_KEY` (already in `.env`)
   - `ELEVENLABS_AGENT_ID` (the agent ID from step 1)
3. **Confirm with the user:** "Agent configured? `ELEVENLABS_AGENT_ID` set? Ready to start Task 1."

---

## Task 1: Add `mode` and `channel` columns to schema

**Files:**
- Modify: `db/schema.ts:56-66` (`chatBotMetadata`)
- Modify: `db/schema.ts:80-88` (`conversation`)
- Generate: `drizzle/<timestamp>_voice_mode.sql`

- [ ] **Step 1: Edit `db/schema.ts` — add `mode` to `chatBotMetadata`**

Replace the `chatBotMetadata` definition (lines 56–66) with:

```ts
export const chatBotMetadata = pgTable("chatBotMetadata", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  user_email: text("user_email").notNull(),
  color: text("color").default("#4f39f6"),
  welcome_message: text("welcome_message").default(
    "Hi there, How can I help you today?"
  ),
  mode: text("mode").notNull().default("text"),
  created_at: text("created_at").default(sql`now()`),
});
```

- [ ] **Step 2: Edit `db/schema.ts` — add `channel` to `conversation`**

Replace the `conversation` definition (lines 80–88) with:

```ts
export const conversation = pgTable("conversation", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  visitor_ip: text("visitor_ip"),
  name: text("name"),
  chatbot_id: text("chatbot_id").notNull(),
  channel: text("channel").notNull().default("text"),
  created_at: text("created_at").default(sql`now()`),
});
```

- [ ] **Step 3: Generate migration**

Run: `npm run db:generate`
Expected: a new file appears in `drizzle/` named `<timestamp>_<random>.sql` containing `ALTER TABLE "chatBotMetadata" ADD COLUMN "mode" text DEFAULT 'text' NOT NULL;` and `ALTER TABLE "conversation" ADD COLUMN "channel" text DEFAULT 'text' NOT NULL;`. Open the file and verify both ALTERs are present.

- [ ] **Step 4: Apply migration**

Run: `npm run db:migrate`
Expected: `[✓] Changes applied`. No errors.

- [ ] **Step 5: Verify in DB**

Run (PowerShell-friendly):
```bash
npm run db:studio
```
Expected: in Drizzle Studio, `chatBotMetadata` shows a `mode` column with value `text` for every existing row, and `conversation` shows a `channel` column with value `text` for every existing row.

- [ ] **Step 6: Commit**

Tell the user: "Task 1 complete. You can commit with:
```bash
git add db/schema.ts drizzle/
git commit -m \"feat(db): add mode to chatBotMetadata and channel to conversation\"
```"

---

## Task 2: Voice token mint/verify helper

**Files:**
- Create: `lib/voiceToken.ts`

- [ ] **Step 1: Create `lib/voiceToken.ts`**

```ts
import { SignJWT, jwtVerify } from "jose";

export interface VoicePayload {
  sessionId: string;
  widgetId: string;
  ownerEmail: string;
  sectionId: string;
  sourceIds: string[];
}

const TTL = "15m";

function getSecret() {
  return new TextEncoder().encode(process.env.JWT_SECRET!);
}

export async function mintVoiceToken(payload: VoicePayload): Promise<string> {
  return await new SignJWT({ ...payload, kind: "voice" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(getSecret());
}

export async function verifyVoiceToken(token: string): Promise<VoicePayload> {
  const { payload } = await jwtVerify(token, getSecret());
  if (payload.kind !== "voice") throw new Error("Wrong token kind");
  const { sessionId, widgetId, ownerEmail, sectionId, sourceIds } = payload as Record<string, unknown>;
  if (
    typeof sessionId !== "string" ||
    typeof widgetId !== "string" ||
    typeof ownerEmail !== "string" ||
    typeof sectionId !== "string" ||
    !Array.isArray(sourceIds)
  ) {
    throw new Error("Invalid voice token payload");
  }
  return {
    sessionId,
    widgetId,
    ownerEmail,
    sectionId,
    sourceIds: sourceIds as string[],
  };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors related to `lib/voiceToken.ts`.

- [ ] **Step 3: Commit**

Tell the user: "Task 2 complete. You can commit with:
```bash
git add lib/voiceToken.ts
git commit -m \"feat(lib): add voice-token mint/verify helpers\"
```"

---

## Task 3: ElevenLabs server-side client

**Files:**
- Create: `lib/elevenlabs.ts`

- [ ] **Step 1: Create `lib/elevenlabs.ts`**

```ts
const BASE_URL = "https://api.elevenlabs.io";

export interface SignedUrlResult {
  signed_url: string;
}

export async function getElevenLabsSignedUrl(params: {
  agentId: string;
  voiceToken: string;
}): Promise<SignedUrlResult> {
  const url = new URL("/v1/convai/conversation/get-signed-url", BASE_URL);
  url.searchParams.set("agent_id", params.agentId);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY!,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs signed-url failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { signed_url: string };
  if (!data.signed_url) {
    throw new Error("ElevenLabs signed-url response missing signed_url");
  }
  return { signed_url: data.signed_url };
}
```

> **Note for the implementer:** ElevenLabs's API returns a per-conversation signed URL that the browser uses to open the WebSocket. The `voice_token` dynamic variable is sent from the **client** (browser) when starting the conversation, not from this server-to-server call. We pass `voiceToken` only so this function's signature matches the spec; if a future ElevenLabs API revision allows pre-binding dynamic variables here, fold it in. For now, the variable is bound on the client side in Task 9.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

Tell the user: "Task 3 complete. You can commit with:
```bash
git add lib/elevenlabs.ts
git commit -m \"feat(lib): add elevenlabs signed-url helper\"
```"

---

## Task 4: Extend `/api/widget/config` to return `mode`

**Files:**
- Modify: `app/api/widget/config/route.ts`

- [ ] **Step 1: Inspect existing code**

Read `app/api/widget/config/route.ts`. The existing return is:
```ts
return NextResponse.json({ metadata: meta, sections: userSections });
```
The `meta` object will already include `mode` after Task 1's migration (it's just another column on the row). **Verify by reading the file** — if any explicit field projection is added later, this task needs updating. For now, no code change is required; the column flows through automatically.

- [ ] **Step 2: Add a no-op verification edit**

Add a single-line guard at the top of the GET handler to make the contract explicit. Replace the existing `return NextResponse.json(...)` line with:

```ts
return NextResponse.json({
  metadata: { ...meta, mode: meta.mode ?? "text" },
  sections: userSections,
});
```

- [ ] **Step 3: Type-check + smoke**

Run: `npx tsc --noEmit`
Expected: no errors.

Manual smoke (after `npm run dev`): `curl 'http://localhost:3000/api/widget/config?token=<valid-token>'` and confirm the JSON includes `metadata.mode`.

- [ ] **Step 4: Commit**

Tell the user: "Task 4 complete. You can commit with:
```bash
git add app/api/widget/config/route.ts
git commit -m \"feat(api): expose mode in widget config\"
```"

---

## Task 5: `POST /api/widget/voice-session`

**Files:**
- Create: `app/api/widget/voice-session/route.ts`

- [ ] **Step 1: Create the route**

```ts
import { NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { db } from "@/db/client";
import { chatBotMetadata, sections as sectionsTable } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { mintVoiceToken } from "@/lib/voiceToken";
import { getElevenLabsSignedUrl } from "@/lib/elevenlabs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: Request) {
  const auth = req.headers.get("Authorization");
  const widgetJwt = auth?.split(" ")[1];
  if (!widgetJwt) {
    return NextResponse.json(
      { error: "Missing session token" },
      { status: 401, headers: corsHeaders }
    );
  }

  let widgetId: string;
  let ownerEmail: string;
  let sessionId: string;
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const { payload } = await jwtVerify(widgetJwt, secret);
    widgetId = payload.widgetId as string;
    ownerEmail = payload.ownerEmail as string;
    sessionId = payload.sessionId as string;
    if (!widgetId || !ownerEmail || !sessionId) throw new Error("bad payload");
  } catch (e) {
    console.error("voice-session: jwt verify failed:", e);
    return NextResponse.json(
      { error: "Invalid session token" },
      { status: 401, headers: corsHeaders }
    );
  }

  let body: { section_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400, headers: corsHeaders }
    );
  }
  const sectionId = body.section_id;
  if (!sectionId) {
    return NextResponse.json(
      { error: "Missing section_id" },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    const [bot] = await db
      .select()
      .from(chatBotMetadata)
      .where(eq(chatBotMetadata.id, widgetId))
      .limit(1);
    if (!bot) {
      return NextResponse.json(
        { error: "Widget not found" },
        { status: 404, headers: corsHeaders }
      );
    }
    if (bot.mode !== "voice" && bot.mode !== "both") {
      return NextResponse.json(
        { error: "Voice mode disabled" },
        { status: 403, headers: corsHeaders }
      );
    }

    const [section] = await db
      .select()
      .from(sectionsTable)
      .where(
        and(
          eq(sectionsTable.id, sectionId),
          eq(sectionsTable.user_email, ownerEmail)
        )
      )
      .limit(1);
    if (!section) {
      return NextResponse.json(
        { error: "Section not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const voiceToken = await mintVoiceToken({
      sessionId,
      widgetId,
      ownerEmail,
      sectionId,
      sourceIds: section.source_ids ?? [],
    });

    const { signed_url } = await getElevenLabsSignedUrl({
      agentId: process.env.ELEVENLABS_AGENT_ID!,
      voiceToken,
    });

    return NextResponse.json(
      { signed_url, voice_token: voiceToken },
      { status: 200, headers: corsHeaders }
    );
  } catch (e) {
    console.error("voice-session error:", e);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke**

Run `npm run dev`. In another terminal:
```bash
curl -X POST http://localhost:3000/api/widget/voice-session \
  -H "Authorization: Bearer <valid widget JWT>" \
  -H "Content-Type: application/json" \
  -d '{"section_id":"<existing-section-id>"}'
```
Expected when `mode="voice"`: 200 with `{ "signed_url": "wss://...", "voice_token": "eyJ..." }`.
Expected when `mode="text"`: 403 `{ "error": "Voice mode disabled" }`.

- [ ] **Step 4: Commit**

Tell the user: "Task 5 complete. You can commit with:
```bash
git add app/api/widget/voice-session/route.ts
git commit -m \"feat(api): add /api/widget/voice-session\"
```"

---

## Task 6: `POST /api/widget/knowledge-search` (tool callback)

**Files:**
- Create: `app/api/widget/knowledge-search/route.ts`

- [ ] **Step 1: Create the route**

```ts
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { knowledge_source } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { verifyVoiceToken } from "@/lib/voiceToken";

export async function POST(req: Request) {
  const voiceToken = req.headers.get("x-voice-token");
  if (!voiceToken) {
    return NextResponse.json(
      { error: "Missing voice token" },
      { status: 401 }
    );
  }

  let payload;
  try {
    payload = await verifyVoiceToken(voiceToken);
  } catch (e) {
    console.error("knowledge-search: token verify failed:", e);
    return NextResponse.json(
      { error: "Invalid voice token" },
      { status: 401 }
    );
  }

  if (payload.sourceIds.length === 0) {
    return NextResponse.json({ result: "" });
  }

  try {
    const rows = await db
      .select({ content: knowledge_source.content })
      .from(knowledge_source)
      .where(inArray(knowledge_source.id, payload.sourceIds));

    const result = rows
      .map((r) => r.content)
      .filter(Boolean)
      .join("\n\n");

    return NextResponse.json({ result });
  } catch (e) {
    console.error("knowledge-search: db error:", e);
    return NextResponse.json({ result: "" });
  }
}
```

> **Why no 500 on DB error:** the agent is mid-call. A failed tool call from the LLM's perspective should still let it speak (just without context). The user will hear a generic answer rather than dead air.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke**

```bash
curl -X POST http://localhost:3000/api/widget/knowledge-search \
  -H "X-Voice-Token: <token-from-Task-5>" \
  -H "Content-Type: application/json" \
  -d '{"query":"shipping"}'
```
Expected: 200 with `{ "result": "<concatenated knowledge content>" }`.

- [ ] **Step 4: Commit**

Tell the user: "Task 6 complete. You can commit with:
```bash
git add app/api/widget/knowledge-search/route.ts
git commit -m \"feat(api): add /api/widget/knowledge-search tool callback\"
```"

---

## Task 7: `POST /api/widget/voice-transcript`

**Files:**
- Create: `app/api/widget/voice-transcript/route.ts`

- [ ] **Step 1: Create the route**

```ts
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { conversation, messages as messagesTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyVoiceToken } from "@/lib/voiceToken";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MAX_CONTENT_BYTES = 4 * 1024;
const MAX_TURNS_PER_SESSION = 200;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: Request) {
  const auth = req.headers.get("Authorization");
  const voiceToken = auth?.split(" ")[1];
  if (!voiceToken) {
    return NextResponse.json(
      { error: "Missing voice token" },
      { status: 401, headers: corsHeaders }
    );
  }

  let payload;
  try {
    payload = await verifyVoiceToken(voiceToken);
  } catch (e) {
    console.error("voice-transcript: token verify failed:", e);
    return NextResponse.json(
      { error: "Invalid voice token" },
      { status: 401, headers: corsHeaders }
    );
  }

  let body: { role?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400, headers: corsHeaders }
    );
  }
  if (
    (body.role !== "user" && body.role !== "assistant") ||
    typeof body.content !== "string" ||
    body.content.length === 0
  ) {
    return NextResponse.json(
      { error: "Invalid body" },
      { status: 400, headers: corsHeaders }
    );
  }
  if (Buffer.byteLength(body.content, "utf8") > MAX_CONTENT_BYTES) {
    return NextResponse.json(
      { error: "Content too large" },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    const ip = (req.headers.get("x-forwarded-for") ?? "Unknown IP").split(",")[0];

    const [existing] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, payload.sessionId))
      .limit(1);

    if (!existing) {
      await db.insert(conversation).values({
        id: payload.sessionId,
        chatbot_id: payload.widgetId,
        visitor_ip: ip,
        name: `#Visitor(${ip})`,
        channel: "voice",
      });
    }

    const turns = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(eq(messagesTable.conversation_id, payload.sessionId));
    if (turns.length >= MAX_TURNS_PER_SESSION) {
      return NextResponse.json(
        { error: "Turn limit reached" },
        { status: 400, headers: corsHeaders }
      );
    }

    await db.insert(messagesTable).values({
      conversation_id: payload.sessionId,
      role: body.role,
      content: body.content,
    });

    return new NextResponse(null, { status: 204, headers: corsHeaders });
  } catch (e) {
    console.error("voice-transcript: db error:", e);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke**

```bash
curl -X POST http://localhost:3000/api/widget/voice-transcript \
  -H "Authorization: Bearer <token-from-Task-5>" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","content":"hello world"}'
```
Expected: 204. Then in Drizzle Studio, confirm a `conversation` row exists with `channel = "voice"` and a `messages` row exists with the content.

- [ ] **Step 4: Commit**

Tell the user: "Task 7 complete. You can commit with:
```bash
git add app/api/widget/voice-transcript/route.ts
git commit -m \"feat(api): add /api/widget/voice-transcript persistence\"
```"

---

## Task 8: Dashboard — mode picker (`<ModeConfig />` + wiring)

**Files:**
- Create: `components/dashboard/chatbot/modeConfig.tsx`
- Modify: `app/api/chatbot/metadata/update/route.ts`
- Modify: `app/dashboard/chatbot/page.tsx`

- [ ] **Step 1: Create `components/dashboard/chatbot/modeConfig.tsx`**

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Mic } from "lucide-react";

export type ChatbotMode = "text" | "voice" | "both";

interface ModeConfigProps {
  mode: ChatbotMode;
  setMode: (m: ChatbotMode) => void;
}

const OPTIONS: { value: ChatbotMode; label: string; hint: string }[] = [
  { value: "text", label: "Text only", hint: "Visitors type to chat" },
  { value: "voice", label: "Voice only", hint: "Visitors talk to a voice agent" },
  { value: "both", label: "Text and voice", hint: "Visitors choose per session" },
];

const ModeConfig = ({ mode, setMode }: ModeConfigProps) => {
  return (
    <Card className="border-white/5 bg-[#0a0a0e]">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Mic className="w-4 h-4 text-zinc-500" />
          <CardTitle className="text-sm font-medium text-white uppercase tracking-wider">
            Conversation Mode
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex items-start gap-3 cursor-pointer p-3 rounded-md border border-white/5 hover:bg-white/4"
          >
            <input
              type="radio"
              name="chatbot-mode"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
              className="mt-0.5"
            />
            <div>
              <Label className="text-zinc-200 text-sm">{opt.label}</Label>
              <p className="text-xs text-zinc-500 mt-0.5">{opt.hint}</p>
            </div>
          </label>
        ))}
      </CardContent>
    </Card>
  );
};

export default ModeConfig;
```

- [ ] **Step 2: Modify `app/api/chatbot/metadata/update/route.ts`**

Replace the entire file with:

```ts
import { db } from "@/db/client";
import { chatBotMetadata } from "@/db/schema";
import { isAuthorized } from "@/lib/isAuthorized";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

const VALID_MODES = new Set(["text", "voice", "both"]);

export async function PUT(req: Request) {
  try {
    const user = await isAuthorized();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { color, welcome_message, mode } = body;

    if (!color || !welcome_message) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }
    if (mode !== undefined && !VALID_MODES.has(mode)) {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }

    const update: Record<string, unknown> = { color, welcome_message };
    if (mode !== undefined) update.mode = mode;

    const [updatedMetadata] = await db
      .update(chatBotMetadata)
      .set(update)
      .where(eq(chatBotMetadata.user_email, user.email!))
      .returning();

    return NextResponse.json(updatedMetadata, { status: 200 });
  } catch (error) {
    console.error("Failed to update chatbot metadata:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Modify `app/dashboard/chatbot/page.tsx`**

In `app/dashboard/chatbot/page.tsx`:

(a) Update the `ChatBotMetadata` interface (around lines 9–16) to include `mode`:
```ts
interface ChatBotMetadata {
  id: string;
  user_email: string;
  color: string;
  welcome_message: string;
  mode: "text" | "voice" | "both";
  created_at: string;
  source_ids: string[];
}
```

(b) Add a `mode` state alongside `primaryColor` and `welcomeMessage` (around lines 29–31):
```ts
const [mode, setMode] = useState<"text" | "voice" | "both">("text");
```

(c) In the `fetchData` effect (around line 40), after `setWelcomeMessage(...)`, add:
```ts
setMode((metaData.mode as "text" | "voice" | "both") ?? "text");
```

(d) Update `handleSave` (around lines 142–165) to include `mode` in the PUT body:
```ts
body: JSON.stringify({
  color: primaryColor,
  welcome_message: welcomeMessage,
  mode,
}),
```

(e) Update `hasChanges` (around lines 167–170):
```ts
const hasChanges = metadata
  ? primaryColor !== (metadata.color || "#4f46e5") ||
    welcomeMessage !== (metadata.welcome_message || "Hi! How can I help you?") ||
    mode !== (metadata.mode ?? "text")
  : false;
```

(f) Import the new component near the top (around line 3):
```ts
import ModeConfig from "@/components/dashboard/chatbot/modeConfig";
```

(g) Render `<ModeConfig />` inside the right-column ScrollArea, just before `<EmbedCodeConfig />` (around line 221):
```tsx
<ModeConfig mode={mode} setMode={setMode} />
<EmbedCodeConfig chatbotId={metadata?.id} />
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual smoke**

`npm run dev`. Open the dashboard chatbot page. Verify:
- The "Conversation Mode" card appears with three radios.
- Changing mode enables the Save button.
- Saving persists (refresh the page; the new mode is still selected).

- [ ] **Step 6: Commit**

Tell the user: "Task 8 complete. You can commit with:
```bash
git add components/dashboard/chatbot/modeConfig.tsx app/api/chatbot/metadata/update/route.ts app/dashboard/chatbot/page.tsx
git commit -m \"feat(dashboard): add chatbot conversation-mode picker\"
```"

---

## Task 9: Install ElevenLabs client SDK

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install**

Run: `npm install @elevenlabs/client`
Expected: `package.json` gains `"@elevenlabs/client": "^x.y.z"` under `dependencies`.

- [ ] **Step 2: Sanity check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

Tell the user: "Task 9 complete. You can commit with:
```bash
git add package.json package-lock.json
git commit -m \"chore(deps): add @elevenlabs/client\"
```"

---

## Task 10: Extract `<TextChat />` from current embed page

**Files:**
- Create: `app/embed/_components/TextChat.tsx`
- Modify: `app/embed/page.tsx` (this task only does the extraction; it stays text-only behaviorally)

- [ ] **Step 1: Create `app/embed/_components/TextChat.tsx`**

This component takes the props it needs from the parent shell. Copy the chat-body markup from the current `app/embed/page.tsx` (lines 257–378) and turn it into a self-contained component with this signature:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Send } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

interface Section {
  id: string;
  name: string;
  source_ids: string[];
}

interface TextChatProps {
  token: string;
  primaryColor: string;
  welcomeMessage: string;
  sections: Section[];
}

const TextChat = ({ token, primaryColor, welcomeMessage, sections }: TextChatProps) => {
  const [messages, setMessages] = useState<any[]>([
    { role: "assistant", content: welcomeMessage, isWelcome: true, section: null },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const handleSend = async () => {
    if (!input.trim()) return;
    const currentSection = sections.find((s) => s.name === activeSection);
    const sourceIds = currentSection?.source_ids || [];
    const userMsg = { role: "user", content: input, section: activeSection };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);
    try {
      const res = await fetch("/api/chat/public", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: [...messages, userMsg], knowledge_source_ids: sourceIds }),
      });
      if (res.ok) {
        const data = await res.json();
        setMessages((prev) => [...prev, { role: "assistant", content: data.response, section: null }]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "I'm having trouble connecting right now. Please try again.", section: null },
        ]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsTyping(false);
    }
  };

  const handleSectionClick = (sectionName: string) => {
    setActiveSection(sectionName);
    const userMsg = { role: "user", content: sectionName, section: null };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);
    setTimeout(() => {
      setIsTyping(false);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `You can ask me any question related to "${sectionName}"`, section: sectionName },
      ]);
    }, 800);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-950/30 p-4 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        <div className="space-y-6 pb-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn("flex w-full flex-col", msg.role === "user" ? "items-end" : "items-start")}
            >
              <div className={cn("flex max-w-[85%] gap-3", msg.role === "user" ? "flex-row-reverse" : "flex-row")}>
                {msg.role !== "user" && (
                  <div className="w-9 h-9 relative rounded-full flex items-center justify-center shrink-0 border border-white/5">
                    <Image
                      src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&q=80&fit=crop"
                      alt="Support Agent"
                      width={50}
                      height={50}
                      className="w-full h-full rounded-full object-cover"
                    />
                    <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-[#0E0E12] rounded-full" />
                  </div>
                )}
                <div className="space-y-2">
                  <div
                    className={cn(
                      "p-3.5 rounded-2xl text-sm leading-relaxed shadow-sm",
                      msg.role === "user"
                        ? "bg-zinc-800 text-zinc-100 rounded-tr-sm"
                        : "bg-white text-zinc-900 rounded-tl-sm"
                    )}
                  >
                    {msg.content}
                  </div>
                  {msg.isWelcome && sections.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1 ml-1 animate-in fade-in slide-in-from-top-1 duration-300">
                      {sections.map((section) => (
                        <button
                          key={section.id}
                          onClick={() => handleSectionClick(section.name)}
                          className="px-3 py-1.5 rounded-full border border-zinc-700 bg-zinc-800/50 hover:bg-zinc-700 hover:border-zinc-600 text-zinc-300 text-xs font-medium transition-all"
                        >
                          {section.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {isTyping && (
            <div className="flex w-full justify-start">
              <div className="flex max-w-[85%] gap-3 flex-row">
                <div className="w-9 h-9 relative rounded-full flex items-center justify-center shrink-0 border border-white/5">
                  <Image
                    src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&q=80&fit=crop"
                    alt="Support Agent"
                    width={50}
                    height={50}
                    className="w-full h-full rounded-full object-cover"
                  />
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-[#0E0E12] rounded-full" />
                </div>
                <div className="p-4 rounded-2xl bg-white text-zinc-900 rounded-tl-sm shadow-sm flex items-center gap-1">
                  <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                  <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                  <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" />
                </div>
              </div>
            </div>
          )}
          <div ref={scrollRef} />
        </div>
      </div>

      <div className="p-4 bg-[#0a0a0e] border-t border-white/5 shrink-0 z-20">
        <div className="relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!activeSection}
            placeholder={activeSection ? "Type a message..." : "Select a topic above..."}
            className="min-h-12.5 max-h-30 pr-12 outline-none text-white bg-zinc-900/50 border-white/10 resize-none rounded-xl disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-zinc-600 focus:ring-1 focus:ring-white/20"
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!activeSection || !input.trim()}
            className={cn(
              "absolute right-2 bottom-2 h-8 w-8 transition-colors shadow-sm",
              !activeSection || !input.trim() ? "bg-zinc-800 text-zinc-500" : ""
            )}
            style={
              activeSection && input.trim()
                ? { backgroundColor: primaryColor, color: "white" }
                : {}
            }
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
        <div className="mt-2 text-center">
          <Link href={"/"} className="text-[10px] text-zinc-600 font-medium hover:text-zinc-500 transition-colors">
            Powered by OneMinute Support
          </Link>
        </div>
      </div>
    </>
  );
};

export default TextChat;
```

- [ ] **Step 2: Slim down `app/embed/page.tsx` to use `<TextChat />`**

Replace the contents of `app/embed/page.tsx` (after `if (loading) return null;`) with the bubble shell that mounts `<TextChat />`:

```tsx
"use client";

import TextChat from "@/app/embed/_components/TextChat";
import {
  AlertCircle,
  ChevronDown,
  MessageCircle,
} from "lucide-react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import React, { useEffect, useState } from "react";

interface ChatBotMetadata {
  id: string;
  color: string;
  welcome_message: string;
  mode: "text" | "voice" | "both";
}

interface Section {
  id: string;
  name: string;
  source_ids: string[];
}

const EmbedPage = () => {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [metadata, setMetadata] = useState<ChatBotMetadata | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    document.body.style.backgroundColor = "transparent";
    document.documentElement.style.backgroundColor = "transparent";
    if (typeof window !== undefined) {
      window.parent.postMessage(
        { type: "resize", width: "60px", height: "60px", borderRadius: "30px" },
        "*"
      );
    }
  }, []);

  const toggleOpen = () => {
    const newState = !isOpen;
    setIsOpen(newState);
    window.parent.postMessage(
      newState
        ? { type: "resize", width: "380px", height: "520px", borderRadius: "12px" }
        : { type: "resize", width: "60px", height: "60px", borderRadius: "30px" },
      "*"
    );
  };

  useEffect(() => {
    if (!token) {
      setError("Missing session token");
      setLoading(false);
      return;
    }
    const fetchConfig = async () => {
      try {
        const res = await fetch(`/api/widget/config?token=${token}`);
        if (!res.ok) throw new Error("Failed to load widget configuration");
        const data = await res.json();
        setMetadata(data.metadata);
        setSections(data.sections || []);
      } catch (err) {
        console.error(err);
        setError("Unable to load chat. Please try again later.");
      } finally {
        setLoading(false);
      }
    };
    fetchConfig();
  }, []);

  const primaryColor = metadata?.color || "#4f46e5";

  if (loading) return null;
  if (error && isOpen) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0A0A0E] text-red-400 p-6 text-center rounded-xl border border-white/10">
        <AlertCircle className="w-10 h-10 mb-2" />
        <p>{error}</p>
      </div>
    );
  }
  if (!isOpen) {
    return (
      <button
        onClick={toggleOpen}
        className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg hover:brightness-110 transition-all text-white"
        style={{ backgroundColor: primaryColor }}
      >
        <MessageCircle className="w-8 h-8" />
      </button>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#0A0A0E] overflow-hidden rounded-xl border border-white/10 shadow-2xl">
      <div className="h-14 border-b border-white/5 flex items-center justify-between px-4 bg-[#0E0E12] shadow-sm shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 border border-white/5 overflow-hidden">
              <Image
                src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&q=80&fit=crop"
                alt="Support Agent"
                width={40}
                height={40}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-[#0E0E12] rounded-full" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white leading-none">Support</h1>
            <span className="text-[11px] text-emerald-400 font-medium">Online</span>
          </div>
        </div>
        <button
          onClick={toggleOpen}
          className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
          aria-label="Minimize Chat"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      </div>

      {token && metadata && (
        <TextChat
          token={token}
          primaryColor={primaryColor}
          welcomeMessage={metadata.welcome_message || "Hi! How can I help you?"}
          sections={sections}
        />
      )}
    </div>
  );
};

export default EmbedPage;
```

- [ ] **Step 3: Type-check + smoke**

Run: `npx tsc --noEmit`
Expected: no errors.

`npm run dev`, open the embed page on a test HTML host. Confirm text chat works exactly like before.

- [ ] **Step 4: Commit**

Tell the user: "Task 10 complete. You can commit with:
```bash
git add app/embed/_components/TextChat.tsx app/embed/page.tsx
git commit -m \"refactor(embed): extract TextChat component\"
```"

---

## Task 11: `<VoiceChat />` component

**Files:**
- Create: `app/embed/_components/VoiceChat.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Conversation } from "@elevenlabs/client";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

interface Section {
  id: string;
  name: string;
  source_ids: string[];
}

interface VoiceChatProps {
  token: string;
  primaryColor: string;
  welcomeMessage: string;
  sections: Section[];
}

type Phase = "idle" | "connecting" | "live" | "error";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

const VoiceChat = ({ token, primaryColor, welcomeMessage, sections }: VoiceChatProps) => {
  const [activeSection, setActiveSection] = useState<Section | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<Turn[]>([
    { role: "assistant", content: welcomeMessage },
  ]);

  const conversationRef = useRef<Conversation | null>(null);
  const voiceTokenRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, phase]);

  const persistTurn = async (turn: Turn) => {
    const vt = voiceTokenRef.current;
    if (!vt) return;
    try {
      await fetch("/api/widget/voice-transcript", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${vt}`,
        },
        body: JSON.stringify(turn),
      });
    } catch (e) {
      console.error("voice-transcript persist failed", e);
    }
  };

  const handleStart = async () => {
    if (!activeSection) return;
    setPhase("connecting");
    setErrorMessage("");

    try {
      // 1. Mic permission
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setErrorMessage("Please allow microphone access to start a voice call.");
        setPhase("error");
        return;
      }

      // 2. Mint signed URL + voice token
      const res = await fetch("/api/widget/voice-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ section_id: activeSection.id }),
      });
      if (!res.ok) {
        setErrorMessage("Couldn't reach the voice service. Please try again.");
        setPhase("error");
        return;
      }
      const { signed_url, voice_token } = await res.json();
      voiceTokenRef.current = voice_token;

      // 3. Open the call
      const convo = await Conversation.startSession({
        signedUrl: signed_url,
        dynamicVariables: { voice_token },
        onConnect: () => setPhase("live"),
        onDisconnect: () => setPhase("idle"),
        onError: (err) => {
          console.error("EL convo error", err);
          setErrorMessage("Connection lost.");
          setPhase("error");
        },
        onModeChange: ({ mode }) => setAgentSpeaking(mode === "speaking"),
        onMessage: ({ message, source }) => {
          if (!message) return;
          const role: "user" | "assistant" = source === "user" ? "user" : "assistant";
          const turn: Turn = { role, content: message };
          setTranscript((prev) => [...prev, turn]);
          persistTurn(turn);
        },
      });
      conversationRef.current = convo;
    } catch (e) {
      console.error("voice start failed:", e);
      setErrorMessage("Couldn't reach the voice service. Please try again.");
      setPhase("error");
    }
  };

  const handleHangup = async () => {
    try {
      await conversationRef.current?.endSession();
    } finally {
      conversationRef.current = null;
      voiceTokenRef.current = null;
      setPhase("idle");
      setAgentSpeaking(false);
    }
  };

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-950/30 p-4 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        <div className="space-y-6 pb-4">
          {transcript.map((t, i) => (
            <div
              key={i}
              className={cn("flex w-full flex-col", t.role === "user" ? "items-end" : "items-start")}
            >
              <div className={cn("flex max-w-[85%] gap-3", t.role === "user" ? "flex-row-reverse" : "flex-row")}>
                {t.role !== "user" && (
                  <div className="w-9 h-9 relative rounded-full flex items-center justify-center shrink-0 border border-white/5">
                    <Image
                      src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&q=80&fit=crop"
                      alt="Support Agent"
                      width={50}
                      height={50}
                      className="w-full h-full rounded-full object-cover"
                    />
                  </div>
                )}
                <div
                  className={cn(
                    "p-3.5 rounded-2xl text-sm leading-relaxed shadow-sm",
                    t.role === "user"
                      ? "bg-zinc-800 text-zinc-100 rounded-tr-sm"
                      : "bg-white text-zinc-900 rounded-tl-sm"
                  )}
                >
                  {t.content}
                </div>
              </div>
            </div>
          ))}

          {phase === "idle" && !activeSection && sections.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1 ml-1 animate-in fade-in slide-in-from-top-1 duration-300">
              {sections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section)}
                  className="px-3 py-1.5 rounded-full border border-zinc-700 bg-zinc-800/50 hover:bg-zinc-700 hover:border-zinc-600 text-zinc-300 text-xs font-medium transition-all"
                >
                  {section.name}
                </button>
              ))}
            </div>
          )}

          {phase === "error" && (
            <div className="bg-red-950/30 border border-red-900/50 text-red-300 text-xs p-3 rounded-md">
              {errorMessage}
            </div>
          )}

          <div ref={scrollRef} />
        </div>
      </div>

      <div className="p-6 bg-[#0a0a0e] border-t border-white/5 shrink-0 z-20 flex flex-col items-center gap-3">
        {phase === "live" ? (
          <>
            <div
              className={cn(
                "w-16 h-16 rounded-full flex items-center justify-center transition-all",
                agentSpeaking ? "animate-pulse" : ""
              )}
              style={{ backgroundColor: primaryColor }}
            >
              <Mic className="w-7 h-7 text-white" />
            </div>
            <span className="text-xs text-zinc-400">
              {agentSpeaking ? "Speaking…" : "Listening…"}
            </span>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleHangup}
              className="bg-red-600 hover:bg-red-700"
            >
              <PhoneOff className="w-4 h-4 mr-2" />
              Hang up
            </Button>
          </>
        ) : (
          <>
            <button
              onClick={handleStart}
              disabled={!activeSection || phase === "connecting"}
              className={cn(
                "w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed",
                phase === "connecting" ? "animate-pulse" : "hover:brightness-110"
              )}
              style={{ backgroundColor: activeSection ? primaryColor : "#3f3f46" }}
              aria-label="Start voice call"
            >
              {activeSection ? (
                <Mic className="w-7 h-7 text-white" />
              ) : (
                <MicOff className="w-7 h-7 text-zinc-300" />
              )}
            </button>
            <span className="text-xs text-zinc-500">
              {phase === "connecting"
                ? "Connecting…"
                : activeSection
                ? `Talk · ${activeSection.name}`
                : "Select a topic above"}
            </span>
          </>
        )}
        <Link
          href={"/"}
          className="text-[10px] text-zinc-600 font-medium hover:text-zinc-500 transition-colors"
        >
          Powered by OneMinute Support
        </Link>
      </div>
    </>
  );
};

export default VoiceChat;
```

> **Note for the implementer:** The `@elevenlabs/client` API surface (method names, callback names like `onModeChange` / `onMessage`) is what the SDK exposes today. If the SDK in your installed version uses different names, **don't fight it** — adjust the callbacks in this file to whatever the installed version uses. The contract this file is responsible for is: track speaking-vs-listening state, push finalized transcript turns to `/api/widget/voice-transcript`, and offer a hang-up affordance. Verify the SDK callback names against `node_modules/@elevenlabs/client` after install.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. If TypeScript complains about `Conversation` callback shapes, rename callbacks to match the installed SDK and re-run.

- [ ] **Step 3: Commit**

Tell the user: "Task 11 complete. You can commit with:
```bash
git add app/embed/_components/VoiceChat.tsx
git commit -m \"feat(embed): add VoiceChat component\"
```"

---

## Task 12: `<ModeToggle />` and routing in `<EmbedPage />`

**Files:**
- Create: `app/embed/_components/ModeToggle.tsx`
- Modify: `app/embed/page.tsx`

- [ ] **Step 1: Create `ModeToggle.tsx`**

```tsx
"use client";

import { cn } from "@/lib/utils";
import { MessageCircle, Mic } from "lucide-react";

interface ModeToggleProps {
  active: "text" | "voice";
  onChange: (m: "text" | "voice") => void;
  primaryColor: string;
}

const ModeToggle = ({ active, onChange, primaryColor }: ModeToggleProps) => {
  return (
    <div className="flex items-center gap-1 p-1 bg-zinc-900/60 border-b border-white/5">
      <button
        onClick={() => onChange("text")}
        className={cn(
          "flex-1 flex items-center justify-center gap-2 py-1.5 text-xs rounded-md transition-colors",
          active === "text" ? "text-white" : "text-zinc-500 hover:text-zinc-300"
        )}
        style={active === "text" ? { backgroundColor: primaryColor } : undefined}
      >
        <MessageCircle className="w-3.5 h-3.5" />
        Chat
      </button>
      <button
        onClick={() => onChange("voice")}
        className={cn(
          "flex-1 flex items-center justify-center gap-2 py-1.5 text-xs rounded-md transition-colors",
          active === "voice" ? "text-white" : "text-zinc-500 hover:text-zinc-300"
        )}
        style={active === "voice" ? { backgroundColor: primaryColor } : undefined}
      >
        <Mic className="w-3.5 h-3.5" />
        Talk
      </button>
    </div>
  );
};

export default ModeToggle;
```

- [ ] **Step 2: Modify `app/embed/page.tsx` to route by mode**

Add the import and a render-time selector. Replace the closing `<TextChat .../>` block (the `{token && metadata && (...)}` chunk) with:

```tsx
import ModeToggle from "@/app/embed/_components/ModeToggle";
import VoiceChat from "@/app/embed/_components/VoiceChat";
// ...inside the component, alongside other useState calls:
const [activeMode, setActiveMode] = useState<"text" | "voice">("text");

useEffect(() => {
  if (!metadata) return;
  if (metadata.mode === "voice") setActiveMode("voice");
  else setActiveMode("text");
}, [metadata?.mode]);
```

And replace the `<TextChat />` mount with:

```tsx
{token && metadata && (
  <>
    {metadata.mode === "both" && (
      <ModeToggle
        active={activeMode}
        onChange={setActiveMode}
        primaryColor={primaryColor}
      />
    )}
    {activeMode === "voice" && (metadata.mode === "voice" || metadata.mode === "both") ? (
      <VoiceChat
        key="voice"
        token={token}
        primaryColor={primaryColor}
        welcomeMessage={metadata.welcome_message || "Hi! How can I help you?"}
        sections={sections}
      />
    ) : (
      <TextChat
        key="text"
        token={token}
        primaryColor={primaryColor}
        welcomeMessage={metadata.welcome_message || "Hi! How can I help you?"}
        sections={sections}
      />
    )}
  </>
)}
```

> **Why `key="voice"` / `key="text"`:** when the user toggles in `mode="both"`, React unmounts the old child and mounts a fresh one. That's intentional — the spec says toggling = new session.

- [ ] **Step 3: Type-check + smoke**

Run: `npx tsc --noEmit`
Expected: no errors.

Manual smoke: set a chatbot to `mode="both"`. Open the embed. Confirm both tabs render and switching unmounts/remounts cleanly.

- [ ] **Step 4: Commit**

Tell the user: "Task 12 complete. You can commit with:
```bash
git add app/embed/_components/ModeToggle.tsx app/embed/page.tsx
git commit -m \"feat(embed): route between text and voice based on mode\"
```"

---

## Task 13: Snippet — `iframe.allow = "microphone"`

**Files:**
- Modify: `public/widget.js`

- [ ] **Step 1: Edit `public/widget.js`**

Open `public/widget.js`. Find the line:

```js
iframe.style.transition = "all 0.3s ease";
```

Add the following line directly before `document.body.appendChild(iframe);`:

```js
iframe.allow = "microphone";
```

So the surrounding block reads:

```js
iframe.style.transition = "all 0.3s ease";
iframe.allow = "microphone";

document.body.appendChild(iframe);
```

- [ ] **Step 2: Commit**

Tell the user: "Task 13 complete. You can commit with:
```bash
git add public/widget.js
git commit -m \"feat(widget): allow microphone for voice mode\"
```"

---

## Task 14: Conversations page — voice badge

**Files:**
- Modify: `app/api/conversations/route.ts`
- Modify: `app/dashboard/conversations/page.tsx`

- [ ] **Step 1: Modify `app/api/conversations/route.ts`**

Find the `return` block inside the `Promise.all`-mapped array (around lines 52–59). Add `channel`:

```ts
return {
  id: c.id,
  user: c.name || "Visitor",
  lastMessage: lastMsg?.content || "Started conversation",
  status: "active",
  time: timeDisplay,
  visitor_ip: c.visitor_ip,
  channel: c.channel ?? "text",
};
```

- [ ] **Step 2: Modify `app/dashboard/conversations/page.tsx`**

(a) Update the `Conversation` interface (lines 17–24) to add `channel`:

```ts
interface Conversation {
  id: string;
  user: string;
  lastMessage: string;
  time: string;
  email?: string;
  visitor_ip?: string;
  channel?: "text" | "voice";
}
```

(b) Add a `Mic` import alongside existing lucide imports (line 6–13):

```ts
import { Loader2, MessageSquare, Mic, MoreHorizontal, Search, Send, User } from "lucide-react";
```

(c) Inside the row's flex container (around line 181, inside `<div className="flex items-center justify-between">`), prefix the username with a channel icon:

```tsx
<div className="flex items-center gap-2 min-w-0">
  {conversation.channel === "voice" ? (
    <Mic className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
  ) : (
    <MessageSquare className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
  )}
  <span
    className={cn(
      "font-medium text-sm truncate max-w-45",
      selectedId === conversation.id ? "text-white" : "text-zinc-300"
    )}
  >
    {conversation.user}
  </span>
</div>
<span className="text-[10px] text-zinc-500 shrink-0">
  {conversation.time}
</span>
```

(replacing the existing `<span className="font-medium ..." />` and matching the existing row layout — the `time` span stays on the right, the icon+name moves to the left half).

- [ ] **Step 3: Type-check + smoke**

Run: `npx tsc --noEmit`
Expected: no errors.

`npm run dev`. Open the Conversations page. Confirm existing conversations show 💬 (MessageSquare) icon. After completing a voice call (Task 11/12), the new conversation row shows 🎤 (Mic) icon.

- [ ] **Step 4: Commit**

Tell the user: "Task 14 complete. You can commit with:
```bash
git add app/api/conversations/route.ts app/dashboard/conversations/page.tsx
git commit -m \"feat(dashboard): show channel icon on conversation rows\"
```"

---

## Task 15: End-to-end manual UAT

This task has no code changes — it's the verification sweep from §9 of the spec.

- [ ] **Step 1: Build cleanly**

Run: `npm run build`
Expected: build passes with no errors.

- [ ] **Step 2: Existing text flow regression check**

Set a chatbot to `mode="text"`. Embed it on a test HTML page (no `iframe allow="microphone"` needed). Open it. Pick a section. Send a text message. Receive a reply. Confirm the conversation appears in the dashboard with the 💬 icon.

- [ ] **Step 3: Voice happy path**

Set a chatbot to `mode="voice"`. Embed it on a test HTML page. The snippet must include `allow="microphone"` (this happens automatically via `widget.js` now). Open it. Pick a section. Tap Talk. Allow mic. Speak. Hear a reply that uses the section's knowledge.

- [ ] **Step 4: Voice transcript persistence**

Hang up. In the dashboard's Conversations page, confirm a new row appears with the 🎤 icon. Click in. Confirm the transcript matches what was said.

- [ ] **Step 5: Both-mode toggle**

Set a chatbot to `mode="both"`. Embed and open. Confirm the Chat/Talk toggle appears. Use both tabs in the same widget instance — each toggle should behave like a fresh session.

- [ ] **Step 6: Mic permission denial**

In a private window, deny mic permission. Confirm the inline error appears ("Please allow microphone access…") and the call does not start.

- [ ] **Step 7: Knowledge edit propagation**

Edit knowledge for a section in the dashboard. Start a new voice call on that section. Confirm the new content reaches the agent (ask a question whose answer was just changed).

- [ ] **Step 8: Final commit (if anything was tweaked)**

If you discovered any small fixes during UAT, commit them. Otherwise no commit needed for this task.

---

## Self-Review

**1. Spec coverage:**
- §1 Goal — Tasks 8 (mode picker), 10–13 (widget routing & voice UI), 7 (transcript persistence), 14 (Conversations badge). ✅
- §2 Non-goals — none introduced; voice picker, recordings, sync are absent. ✅
- §3 Architecture — Tasks 5, 6, 7, 4 cover all four endpoints; Task 9 adds the SDK; Tasks 10–12 cover the routing. ✅
- §4 Data model — Task 1 adds both columns. ✅
- §5 Endpoints — Tasks 4 (config), 5 (voice-session), 6 (knowledge-search), 7 (voice-transcript). ✅
- §6 UI — Task 8 (dashboard), Tasks 10–12 (widget render modes), Task 11 (voice 3 states), Task 14 (badge), Task 13 (snippet). ✅
- §7 Error handling — Task 6 returns `{result:""}` on DB error; Task 11 handles mic-denied / connect-fail / disconnect; Task 7 enforces 4 KB / 200 turns. ✅
- §8 Security — Task 5 mints scoped voice token; Task 6 has no CORS (server-to-server); Tasks 5 & 7 have CORS for iframe; Task 7 enforces content limits. ✅
- §9 Testing — Task 15 covers all manual UAT bullets. ✅
- §10 Rollout — Task 1's default `mode="text"` is the implicit flag; Pre-flight covers env vars; Task 13 covers the snippet change. ✅

**2. Placeholder scan:** No "TBD" / "TODO" / "implement later" / generic "handle errors" lines found. The two **Note for the implementer** callouts (Task 3 and Task 11) are explicit guidance, not placeholders.

**3. Type consistency:**
- `VoicePayload` defined in Task 2 is consumed by Tasks 5, 6, 7 with matching field names (`sessionId`, `widgetId`, `ownerEmail`, `sectionId`, `sourceIds`). ✅
- `ChatbotMode` / `mode` values `"text" | "voice" | "both"` used consistently across schema (Task 1), API (Task 8), dashboard (Task 8), embed (Tasks 10–12). ✅
- `channel` values `"text" | "voice"` used consistently across schema (Task 1), API (Task 14), Conversations page (Task 14). ✅
- Endpoint paths consistent: `/api/widget/voice-session` (Task 5, called by Task 11); `/api/widget/knowledge-search` (Task 6, hit by ElevenLabs); `/api/widget/voice-transcript` (Task 7, called by Task 11). ✅

No issues found.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-18-voice-chat-elevenlabs.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
