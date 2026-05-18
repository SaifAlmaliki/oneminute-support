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
