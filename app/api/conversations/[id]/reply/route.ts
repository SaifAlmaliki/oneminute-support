import { db } from "@/db/client";
import { chatBotMetadata, conversation, messages } from "@/db/schema";
import { isAuthorized } from "@/lib/isAuthorized";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await isAuthorized();
    if (!user)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: conversationId } = await params;
    const { content } = await req.json();

    if (!content || !content.trim()) {
      return NextResponse.json(
        { error: "Content is required" },
        { status: 400 }
      );
    }

    const [conv] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, conversationId));
    if (!conv)
      return NextResponse.json({ error: "Not found" }, { status: 404 });

    const [bot] = await db
      .select()
      .from(chatBotMetadata)
      .where(
        and(
          eq(chatBotMetadata.id, conv.chatbot_id),
          eq(chatBotMetadata.user_email, user.email)
        )
      );

    if (!bot) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await db.insert(messages).values({
      conversation_id: conversationId,
      role: "assistant",
      content: content,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Reply Error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
