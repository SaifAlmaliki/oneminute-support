import scalekit from "@/lib/scalekit";
import { getPostLogoutRedirectUri } from "@/lib/scalekit-env";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const cookieStore = await cookies();
  const raw = cookieStore.get("user_session")?.value;

  let idTokenHint: string | undefined;
  if (raw) {
    try {
      const session = JSON.parse(raw) as { id_token?: string };
      idTokenHint = session.id_token;
    } catch {
      /* ignore malformed session */
    }
  }

  cookieStore.delete("user_session");
  cookieStore.delete("metadata");
  cookieStore.delete("sk_state");

  const logoutUrl = scalekit.getLogoutUrl({
    idTokenHint,
    postLogoutRedirectUri: getPostLogoutRedirectUri(),
  });

  return NextResponse.redirect(logoutUrl);
}
