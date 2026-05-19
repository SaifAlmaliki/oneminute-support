import { NextResponse } from "next/server";
import { verifyVoiceToken } from "@/lib/voiceToken";
import { retrieveContext } from "@/lib/rag/retrieve";
import { formatChunkForPrompt } from "@/lib/rag/format";

export async function POST(req: Request) {
  const voiceToken = req.headers.get("x-voice-token");
  if (!voiceToken) {
    return NextResponse.json({ error: "Missing voice token" }, { status: 401 });
  }

  let payload;
  try {
    payload = await verifyVoiceToken(voiceToken);
  } catch (e) {
    console.error("knowledge-search: token verify failed:", e);
    return NextResponse.json({ error: "Invalid voice token" }, { status: 401 });
  }

  if (payload.sourceIds.length === 0) {
    return NextResponse.json({ result: "" });
  }

  const body = await req.json().catch(() => ({} as any));
  const query = (body.query as string | undefined) ?? "";

  if (!query) {
    return NextResponse.json({ result: "" });
  }

  try {
    const chunks = await retrieveContext({
      query,
      sourceIds: payload.sourceIds,
      userEmail: payload.ownerEmail,
      topK: 5,
    });

    const result = chunks.length === 0
      ? ""
      : chunks.map((c, i) => formatChunkForPrompt(c, i + 1)).join("\n\n");

    return NextResponse.json({ result });
  } catch (e) {
    console.error("knowledge-search: retrieval error:", e);
    return NextResponse.json({ result: "" });
  }
}
