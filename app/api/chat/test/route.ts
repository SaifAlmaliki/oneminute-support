import { countConversationTokens } from "@/lib/countConversationTokens";
import { isAuthorized } from "@/lib/isAuthorized";
import { openai, summarizeConversation } from "@/lib/openAI";
import { retrieveContext } from "@/lib/rag/retrieve";
import { formatChunkForPrompt } from "@/lib/rag/format";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const user = await isAuthorized();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let { messages, knowledge_source_ids } = await req.json();

  const lastMessage = messages[messages.length - 1];

  const chunks = (lastMessage && lastMessage.role === "user")
    ? await retrieveContext({
        query: lastMessage.content,
        sourceIds: knowledge_source_ids ?? [],
        userEmail: user.email,
        topK: 5,
      })
    : [];

  let context = chunks.length === 0
    ? ""
    : chunks.map((c, i) => formatChunkForPrompt(c, i + 1)).join("\n\n");

  const tokenCount = countConversationTokens(messages);
  if (tokenCount > 6000) {
    const recentMessages = messages.slice(-10);
    const olderMessages = messages.slice(0, -10);

    if (olderMessages.length > 0) {
      const summary = await summarizeConversation(olderMessages);
      context = `PREVIOUS CONVERSATION SUMMARY:\n${summary} \n\n` + context;
      messages = recentMessages;
    }
  }

  const emptyContextNote = chunks.length === 0
    ? `\nIMPORTANT: No relevant information was found in the knowledge base for this question. Acknowledge that you don't have information on this topic, then offer to create a support ticket.\n`
    : "";

  const systemPrompt = `Your name is Sarah. You are a friendly, human-like customer support specialist.

CRITICAL RULES:
- If asked for your name, always respond with "I'm Sarah".
- If asked for your role, always respond with "I'm a customer support specialist".
- Keep answers EXTREMELY SHORT (max 1-2 sentences) and conversational.
- If the user asks a broad question, DO NOT provide a summary. Instead, ask a friendly clarifying question to understand exactly what they need help with.
- Never dump information. Always conversationally guide the user to the specific answer they need.
- Mirror the user's brevity.

GROUNDING:
- Answer ONLY using the numbered context blocks below. Each block has format "[N] Source: ..." — use it.
- When you state a fact, append the citation in square brackets, e.g., "Returns are accepted within 30 days [1]."
- If the context does not contain the answer, say so — never guess, never use general knowledge to fill gaps.
${emptyContextNote}
ESCALATION PROTOCOL:
- If you simply DON'T KNOW the answer from the context, or if the user indicates they are unhappy, ask: "Would you like me to create a support ticket for our specialist team?"
- If the user says "Yes" or gives permission to create a ticket, your reply MUST be: "[ESCALATED] I have created a support ticket. Our specialist team will review this conversation and contact you shortly."

Context:
${context}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature: 0.7,
      max_tokens: 200,
    });

    const reply =
      completion.choices[0].message.content ||
      "I'm sorry, I couldn't generate a response.";

    return NextResponse.json({ response: reply });
  } catch (error) {
    console.error("OpenAI Error:", error);
    return NextResponse.json(
      { response: "An error occurred while processing your request." },
      { status: 500 }
    );
  }
}
