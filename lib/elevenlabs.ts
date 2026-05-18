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
