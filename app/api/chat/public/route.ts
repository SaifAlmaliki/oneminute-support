import { NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { db } from "@/db/client";
import { conversation } from "@/db/schema";
import { messages as messagesTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { countConversationTokens } from "@/lib/countConversationTokens";
import { openai, summarizeConversation } from "@/lib/openAI";
import { retrieveContext } from "@/lib/rag/retrieve";
import { formatChunkForPrompt } from "@/lib/rag/format";

export async function POST(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.split(" ")[1];

  if (!token) {
    return NextResponse.json(
      { error: "Missing session token" },
      { status: 401 }
    );
  }

  let sessionId: string | undefined;
  let widgetId: string | undefined;
  let ownerEmail: string | undefined;

  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const { payload } = await jwtVerify(token, secret);
    sessionId = payload.sessionId as string;
    widgetId = payload.widgetId as string;
    ownerEmail = payload.ownerEmail as string;

    if (!sessionId || !widgetId || !ownerEmail) {
      throw new Error("Invalid Token Payload");
    }
  } catch (error) {
    console.error("Token Verification Failed:", error);
    return NextResponse.json(
      { error: "Invalid or expired session token" },
      { status: 401 }
    );
  }

  let { messages, knowledge_source_ids } = await req.json();

  const lastMessage = messages[messages.length - 1];

  if (!lastMessage || lastMessage.role !== "user") {
    console.log("No new user message detected or invalid format");
  }

  // Persist conversation + user message
  try {
    const [existingConv] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, sessionId))
      .limit(1);

    if (!existingConv) {
      const forwardedFor = req.headers.get("x-forwarded-for");
      const ip = forwardedFor ? forwardedFor.split(",")[0] : "Unknown IP";
      const visitorName = `#Visitor(${ip})`;

      await db.insert(conversation).values({
        id: sessionId,
        chatbot_id: widgetId,
        visitor_ip: ip,
        name: visitorName,
      });

      const previousMessages = messages.slice(0, -1);
      for (const msg of previousMessages) {
        await db.insert(messagesTable).values({
          conversation_id: sessionId,
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }
    }

    if (lastMessage && lastMessage.role === "user") {
      await db.insert(messagesTable).values({
        conversation_id: sessionId,
        role: "user",
        content: lastMessage.content,
      });
    }
  } catch (error) {
    console.error("Database Persistence Error (User):", error);
  }

  // Retrieve via RAG
  const chunks = (lastMessage && lastMessage.role === "user")
    ? await retrieveContext({
        query: lastMessage.content,
        sourceIds: knowledge_source_ids ?? [],
        userEmail: ownerEmail,
        topK: 5,
      })
    : [];

  let context = chunks.length === 0
    ? ""
    : chunks.map((c, i) => formatChunkForPrompt(c, i + 1)).join("\n\n");

  // Rolling summary at 6k tokens
  const tokenCount = countConversationTokens(messages);
  if (tokenCount > 6000) {
    const recentMessages = messages.slice(-10);
    const olderMessages = messages.slice(0, -10);

    if (olderMessages.length > 0) {
      const summary = await summarizeConversation(olderMessages);
      context = `PREVIOUS CONVERSATION SUMMARY:\n${summary}\n\n` + context;
      messages = recentMessages;
    }
  }

  const emptyContextNote = chunks.length === 0
    ? `\nIMPORTANT: No relevant information was found in the knowledge base for this question. Acknowledge that you don't have information on this topic, then offer to create a support ticket.\n`
    : "";

  const systemPrompt = `Your name is Sarah. You are a friendly, human-like customer support specialist.

CRITICAL RULES:
- If asked for your name, always respond with "I'm Sarah".
- Keep answers EXTREMELY SHORT (max 1-2 sentences) and conversational.
- If the user asks a broad question, ask a clarifying question.
- Never dump information. Guide the user conversationally.
- Mirror the user's brevity.

GROUNDING:
- Answer ONLY using the numbered context blocks below. Each block has format "[N] Source: ..." — use it.
- When you state a fact, append the citation in square brackets, e.g., "Returns are accepted within 30 days [1]."
- If the context does not contain the answer, say so — never guess, never use general knowledge to fill gaps.
${emptyContextNote}
ESCALATION PROTOCOL:
- If you don't know the answer or the user is unhappy, ask: "Would you like me to create a support ticket?"
- If they say "Yes", reply: "[ESCALATED] I have created a support ticket. Our specialist team will review (etc)."

Context:
${context}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature: 0.7,
      max_tokens: 200,
    });

    const reply =
      completion.choices[0].message.content ||
      "I'm sorry, I couldn't generate a response.";

    try {
      await db.insert(messagesTable).values({
        conversation_id: sessionId,
        role: "assistant",
        content: reply,
      });
    } catch (error) {
      console.error("Database Persistence Error (AI):", error);
    }
    return NextResponse.json({ response: reply });
  } catch (error) {
    console.error("OpenAI Error:", error);
    return NextResponse.json(
      { response: "An error occurred." },
      { status: 500 }
    );
  }
}
