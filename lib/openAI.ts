import OpenAI from "openai";
import https from "https";

const agent = new https.Agent({
  rejectUnauthorized: false, // For development - set to true in production
});

const customFetch = (url: RequestInfo | URL, init?: RequestInit) => {
  return fetch(url, {
    ...init,
    // @ts-ignore - Node.js specific
    agent: url.toString().startsWith("https") ? agent : undefined,
  });
};

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  fetch: customFetch,
  baseURL: process.env.OPENAI_BASE_URL,
});

export async function summarizeConversation(messages: any[]) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 500,
      messages: [
        {
          role: "system",
          content:
            "Summarize the following conversation history into a concise paragraph, preserving key details and user intent.The final output MUST be under 2000 words.",
        },
        ...messages,
      ],
    });

    return completion.choices[0].message.content?.trim() ?? "";
  } catch (error) {
    console.error("Error in summarizeConversation:", error);
    throw error;
  }
}
