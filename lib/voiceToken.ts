import { SignJWT, jwtVerify } from "jose";

export interface VoicePayload {
  sessionId: string;
  widgetId: string;
  ownerEmail: string;
  sectionId: string;
  sourceIds: string[];
}

const TTL = "15m";

function getSecret() {
  return new TextEncoder().encode(process.env.JWT_SECRET!);
}

export async function mintVoiceToken(payload: VoicePayload): Promise<string> {
  return await new SignJWT({ ...payload, kind: "voice" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(getSecret());
}

export async function verifyVoiceToken(token: string): Promise<VoicePayload> {
  const { payload } = await jwtVerify(token, getSecret());
  if (payload.kind !== "voice") throw new Error("Wrong token kind");
  const { sessionId, widgetId, ownerEmail, sectionId, sourceIds } = payload as Record<string, unknown>;
  if (
    typeof sessionId !== "string" ||
    typeof widgetId !== "string" ||
    typeof ownerEmail !== "string" ||
    typeof sectionId !== "string" ||
    !Array.isArray(sourceIds)
  ) {
    throw new Error("Invalid voice token payload");
  }
  return {
    sessionId,
    widgetId,
    ownerEmail,
    sectionId,
    sourceIds: sourceIds as string[],
  };
}
