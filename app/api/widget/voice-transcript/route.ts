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
