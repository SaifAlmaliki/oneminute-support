# Voice Chat via ElevenLabs Conversational AI — Design

**Date:** 2026-05-18
**Status:** Approved (pending user spec review)
**Scope:** Add a voice-chat mode to the embeddable widget alongside the existing text chat, using ElevenLabs Conversational AI.

---

## 1. Goal

Let chatbot owners offer their site visitors a voice conversation in addition to (or instead of) the current text chat. The same install snippet — `<script data-id="...">` — should support either mode. The owner picks the mode from the dashboard. Voice conversations should appear in the existing Conversations page exactly like text ones.

## 2. Non-goals

- Per-chatbot voice selection (one voice for all chatbots in v1).
- Cross-section conversations in voice mode (a call is scoped to one section; switching sections = new call).
- Audio recordings or replay of voice calls (only text transcripts are persisted).
- Programmatic creation/configuration of ElevenLabs agents (the agent is configured manually in their dashboard, once).
- Knowledge-source synchronization between OneMinute and ElevenLabs (knowledge stays in our DB; agent fetches it via tool callback).
- Automated tests, load tests, abuse-protection beyond a basic per-widget concurrency cap.

## 3. Architecture overview

Today: text in → REST (`/api/chat/public`) → OpenAI → text out.

Adding: a parallel voice path: audio in → ElevenLabs Conversational AI agent (WebSocket) → audio out. Both paths share Sections, the section picker, and persistence into `conversation` / `messages`.

Key architectural points:

1. **Mode lives in `chatBotMetadata`.** New column `mode: "text" | "voice" | "both"`, default `"text"`. The owner sets it from the dashboard. The snippet (`public/widget.js`) does not change beyond adding `iframe.allow = "microphone"`.
2. **One ElevenLabs agent, configured manually.** Voice, base system prompt, and a `search_knowledge` webhook tool are configured once in the ElevenLabs dashboard. `agent_id` lives in `ELEVENLABS_AGENT_ID` env. No code calls the ElevenLabs management API.
3. **Tool-callback for knowledge.** When the agent needs context, it hits `POST /api/widget/knowledge-search` on our server. We run the same retrieval the text flow uses (read `knowledge_source.content` for the section's `source_ids`). One source of truth.
4. **Three new endpoints, one modified.**
   - `POST /api/widget/voice-session` — mints signed URL for ElevenLabs WebSocket.
   - `POST /api/widget/knowledge-search` — tool callback hit by ElevenLabs.
   - `POST /api/widget/voice-transcript` — receives finalized turns from the widget; writes to `messages` / `conversation`.
   - `GET /api/widget/config` — extended to return `metadata.mode`.
5. **Two trust domains.** End-user → our server: existing widget JWT (`JWT_SECRET`). ElevenLabs → our server: a separate per-session HMAC voice token, also signed with `JWT_SECRET`, scoped to one call.

```
[third-party site]
  └─ widget.js (snippet, iframe allow="microphone")
      └─ <iframe src="/embed?token=...">
          ├─ TEXT MODE: existing flow, no changes
          └─ VOICE MODE (new):
              ├─ section picker (reuses existing UI)
              ├─ "Talk" button →
              │     POST /api/widget/voice-session  → { signed_url, voice_token }
              ├─ WebSocket → ElevenLabs agent (audio in/out + transcript events)
              └─ on each finalized turn → POST /api/widget/voice-transcript

[ElevenLabs agent]
  └─ tool: search_knowledge
      └─ POST /api/widget/knowledge-search → returns context blob
```

## 4. Data model

Two additive columns. No destructive migrations.

### 4.1 `chatBotMetadata`

```ts
mode: text("mode").notNull().default("text")  // "text" | "voice" | "both"
```

Plain `text` to match codebase convention. Validated in app code.

### 4.2 `conversation`

```ts
channel: text("channel").notNull().default("text")  // "text" | "voice"
```

Lets the Conversations page show a voice/text icon per row. Default keeps existing rows correct.

### 4.3 `messages`

No change. Voice turns reuse `role` / `content`.

### 4.4 Per-session voice tokens — not stored

Issued by `/voice-session` (jose, HS256, `JWT_SECRET`, TTL 15 min) carrying `{ sessionId, widgetId, ownerEmail, sectionId, sourceIds[] }`. Stateless — no new table.

### 4.5 Migration

`npm run db:generate` produces one migration; `npm run db:migrate` applies it. Both columns have defaults; existing rows immediately become valid.

## 5. Endpoints

### 5.1 `POST /api/widget/voice-session` (new)

**Purpose:** mint the signed connection URL the widget uses to open a WebSocket to ElevenLabs.

**Request:** `Authorization: Bearer <existing widget JWT>` + body `{ section_id: string }`.

**Steps:**
1. Verify widget JWT → `widgetId`, `ownerEmail`, `sessionId`.
2. Look up section, confirm `section.user_email === ownerEmail`, read `source_ids`.
3. Verify `chatBotMetadata.mode` for `widgetId` is `"voice"` or `"both"`. Else 403.
4. Mint voice token (jose, HS256, TTL 15 min) with `{ sessionId, widgetId, ownerEmail, sectionId, sourceIds }`.
5. Call ElevenLabs' get-signed-URL REST endpoint with `ELEVENLABS_AGENT_ID` and `ELEVENLABS_API_KEY`, passing the voice token as a `dynamic_variable` so the agent forwards it on tool calls.
6. Return `{ signed_url, voice_token }`.

**CORS:** required (called from iframe). Same allow-list pattern as `/api/widget/session`.

**Why a separate voice token:** the existing widget JWT must not leak to ElevenLabs. The voice token is purpose-scoped (one call, one section, short TTL).

### 5.2 `POST /api/widget/knowledge-search` (new — ElevenLabs calls this)

**Purpose:** tool callback. Returns the knowledge context blob for the section.

**Request:** `{ query: string }` from ElevenLabs; voice token in `X-Voice-Token` header.

**Steps:**
1. Verify voice token → `sourceIds`, `sectionId`, `widgetId`.
2. `select content from knowledge_source where id in (sourceIds)`.
3. Return `{ result: <concatenated content> }`.

**Notes:**
- `query` is ignored in v1 — same retrieval semantics as the text flow (no chunking, no semantic search).
- On DB error: return `{ result: "" }`, status 200. Never 500 — a tool failure must not kill the call.
- **No CORS.** Server-to-server only.
- Per-widget rate limit (e.g., 60 req/min) is a documented v2 follow-up.

### 5.3 `POST /api/widget/voice-transcript` (new — widget calls this)

**Purpose:** persist finalized voice turns into `messages` / `conversation`.

The *widget* sends transcripts (not ElevenLabs via webhook) because ElevenLabs already streams transcript events to the WebSocket client; the widget already has them. This avoids configuring a second auth path.

**Request:** `Authorization: Bearer <voice_token>` + body `{ role: "user" | "assistant", content: string }`.

**Steps:**
1. Verify voice token → `sessionId`, `widgetId`, `ownerEmail`.
2. Upsert `conversation` row (`id = sessionId`, `chatbot_id = widgetId`, `channel = "voice"`). Same upsert behavior as `/api/chat/public`.
3. Insert `messages` row.
4. Return 204.

**CORS:** required (called from iframe).

**Limits:** cap `content.length` at 4 KB; cap turns per session at 200. Reject excess with 400; log.

### 5.4 `GET /api/widget/config` (modified)

Add `metadata.mode` to the response payload. Trivial — `mode` is already on the row after migration.

### 5.5 End-to-end voice call sequence

```
1. User opens widget bubble → /api/widget/config returns mode="voice" or "both"
2. User taps a Section → widget stores section_id locally
3. User taps "Talk":
   POST /api/widget/voice-session { section_id }
   ← { signed_url, voice_token }
4. Widget opens WebSocket to signed_url
   - Browser asks for mic permission
   - Audio streams both directions
5. Agent hits its search_knowledge tool:
   POST /api/widget/knowledge-search (server-to-server, X-Voice-Token header)
   ← { result: <context blob> }
6. As ElevenLabs streams transcript events, widget POSTs each finalized turn:
   POST /api/widget/voice-transcript { role, content }
7. User taps "Hang Up" → widget closes the WebSocket
8. Conversations page shows the new voice conversation with a 🎤 badge
```

**Invariant:** the voice token is the unit of trust for one call. It carries the exact section scope and is short-lived. Switching sections = new call = new token.

## 6. UI changes

### 6.1 Dashboard — chatbot mode picker

In the chatbot edit screen (`app/dashboard/chatbot/page.tsx` or wherever `chatBotMetadata` is edited), add one `<Select>`:

```
Conversation mode:  [ Text only ▾ ]
                    ├─ Text only         (default)
                    ├─ Voice only
                    └─ Text and voice
```

One field, one save action. PATCH against the existing chatbot-update endpoint.

### 6.2 Embed widget — three render modes

`app/embed/page.tsx` is one component today and always renders text. Split on `metadata.mode`:

- **`mode === "text"`** — exactly today's UI; no behavior change.
- **`mode === "voice"`** — voice-only UI (Section 6.3).
- **`mode === "both"`** — section picker first, then a small "💬 Chat / 🎙️ Talk" toggle inside the conversation panel. Tapping a tab swaps which UI is mounted; an in-progress call/conversation does not survive the swap (treat as a new session).

Refactor:
- Extract today's chat body into `<TextChat />` (`app/embed/_components/TextChat.tsx`).
- New `<VoiceChat />` (`app/embed/_components/VoiceChat.tsx`).
- `<EmbedPage />` remains the bubble shell, header, section picker, footer; routes to `<TextChat />` or `<VoiceChat />` based on mode (and toggle, when mode is `"both"`).

### 6.3 Voice widget UI — three states

Same bubble dimensions as today (380×520 when open).

**State 1 — idle (just opened / section selected):**
- Section picker chips at top (same as text mode).
- Below them: a large circular mic button labeled "Talk", chatbot's primary color.
- Disabled until a section is chosen, mirroring the existing "select a topic" gate.

**State 2 — connected:**
- Big circle becomes a pulsing waveform-ish indicator. Status label swaps based on agent events:
  - "Listening…" (mic open / user speaking)
  - "Speaking…" (agent audio playing)
- Scrollable transcript area above the indicator — same message bubbles as text mode, populated live as ElevenLabs streams transcript events.
- Small red "Hang up" pill button below the indicator.

**State 3 — error / permission denied:**
- Same red error layout the embed already uses for `error && isOpen`.
- Distinguish three cases:
  - Mic permission denied: "Please allow microphone access" + retry button.
  - Connection failed: "Couldn't reach the voice service." + retry button.
  - Session expired: "Please refresh and try again."

**No mode toggle inside `mode === "voice"`.** No text input — period. The toggle only appears when `mode === "both"`.

### 6.4 Conversations page — voice badge

`app/dashboard/conversations/page.tsx`: each row shows a small icon — 💬 for `channel === "text"`, 🎤 for `channel === "voice"`. Otherwise the row, the message detail view, everything else, stays identical. Voice transcripts already render correctly because they're plain text in the existing schema.

### 6.5 Snippet (`public/widget.js`) — one line

Add `iframe.allow = "microphone";` before `document.body.appendChild(iframe);`. Without this, the browser blocks `getUserMedia` inside the iframe. Document in release notes that customers must re-paste the snippet to enable voice mode (or configure their host page's CSP to allow microphone, but the snippet change is the simpler path).

### 6.6 YAGNI — explicitly not in v1

- Voice picker (one shared voice).
- Push-to-talk vs hold-to-talk toggle (use ElevenLabs' default open-mic + VAD).
- Audio playback controls in the transcript (replay, download).
- "Still there?" timeout handling beyond the WebSocket's natural close.
- Call recording beyond the text transcript.
- Analytics on call duration, drop rate, etc.

## 7. Error handling

| Failure | Where | User-visible behavior |
|---|---|---|
| `ELEVENLABS_API_KEY` missing/invalid | `voice-session` calls ElevenLabs and gets 401 | 500 to widget → "Couldn't reach the voice service. Please try again." |
| Voice mode disabled for this chatbot | `voice-session` checks `mode` | 403 to widget; widget should never have shown Talk; treat as bug, log loudly |
| Section doesn't belong to owner | `voice-session` cross-checks `section.user_email` | 403 → generic error |
| Voice token expired (15 min) mid-call | tool callback or transcript POST | Tool returns "Session expired"; widget closes WS, shows "Please start a new conversation" |
| Mic permission denied | browser `getUserMedia` rejection | Inline "Please allow microphone access" + retry. Don't open the WebSocket. |
| WebSocket drops mid-call | widget `onclose` handler | Show "Connection lost." + reconnect button. **Reconnect = new `sessionId`** (new voice token). |
| Tool callback fails (DB down) | `knowledge-search` returns 200 with `{ result: "" }` | Agent responds without context. Log the DB error. **Never 500.** |
| Transcript POST fails | `voice-transcript` returns 500 | Widget logs and continues. Best-effort persistence. The call is more important. |
| User hangs up while audio is playing | normal | Widget closes WS, last assistant turn may be partial — persist what we have. |

**Logging convention:** match existing codebase — `console.error("...:", error)` plus generic 500 to client. Don't leak ElevenLabs error details to the iframe.

## 8. Security

1. **Voice token leakage.** Short-lived (15 min), scoped to one section. Even if leaked it can only fetch knowledge already public-readable for this widget. Acceptable.
2. **`/knowledge-search` is reachable from the public internet.** Defense in depth:
   - Voice token in `X-Voice-Token`, verified via jose.
   - Source-IP pinning (if ElevenLabs publishes a stable range): documented for v2.
   - Per-widget rate limit (60 req/min): documented for v2.
3. **`/voice-transcript` is reachable from the iframe.** A malicious page with a leaked voice token could spam fake transcripts. Mitigations:
   - Voice token is bound to `sessionId` + `widgetId`; rows can only land in that conversation.
   - Cap content length at 4 KB; cap turns per session at 200.
   - Log unusual patterns.
4. **Mic permission requires `iframe allow="microphone"`.** Snippet adds it; release notes call out the re-paste requirement.
5. **Cost / abuse.** ElevenLabs charges per minute. v1 mitigation: cap concurrent voice sessions per `widgetId` at 5 using a short-lived in-memory counter. Real DDoS protection is v2.
6. **CORS.**
   - `/voice-session` and `/voice-transcript`: CORS headers required (called from iframe). Match the pattern in `/api/widget/session`.
   - `/knowledge-search`: **no CORS** (server-to-server only).

## 9. Testing — manual, not automated

The repo has no test runner; do not introduce one for this feature.

**Pre-merge sanity checks (local):**
- `npm run build` passes.
- TypeScript strict passes.
- `npx next lint` clean on changed files.
- Migration applies cleanly on a fresh DB and a copy of prod schema.

**Manual UAT (against a Vercel preview):**
1. Existing text chatbots still work end-to-end.
2. Set a chatbot to `mode="voice"`, embed it on a test HTML page with `iframe allow="microphone"`. Open it. Pick a section. Tap Talk. Speak. Hear a reply that uses the section's knowledge.
3. Hang up. Confirm the conversation appears in the dashboard with the 🎤 badge and the transcript matches what was said.
4. Set a chatbot to `mode="both"`. Toggle between Chat and Talk. Both work in the same widget instance.
5. Deny mic permission. Inline error appears.
6. Disconnect the network mid-call. "Connection lost" reconnect path works.
7. Edit knowledge for a section, start a new voice call, confirm new content reaches the agent (proves no stale caching anywhere).

**Not tested in v1:** load testing, concurrent-session limits, ElevenLabs outage simulation. Documented as v2 work.

## 10. Rollout

- No feature flag — the `mode` column itself is the flag. Default `"text"` keeps voice off until an owner opts in.
- Two env vars to add to Vercel:
  - `ELEVENLABS_API_KEY` (already in `.env`)
  - `ELEVENLABS_AGENT_ID` (new — set after configuring the agent in the ElevenLabs dashboard)
- One snippet change (`iframe.allow = "microphone"`). Existing customers must re-paste the snippet to enable voice. Document in release notes.

## 11. Open follow-ups (out of scope for v1)

- Per-chatbot voice override (new column on `chatBotMetadata`, passed as a per-conversation override to ElevenLabs).
- Source-IP pinning on `/knowledge-search`.
- Per-widget rate limits on `/knowledge-search` and `/voice-transcript`.
- Concurrent-session caps backed by a real store (Upstash or DB).
- Audio recording / replay.
- Smart routing in voice ("agent picks the section") — currently rejected as flaky.
- Knowledge sync into ElevenLabs' own KB (rejected for v1; tool-callback wins).
