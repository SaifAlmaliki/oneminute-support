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
