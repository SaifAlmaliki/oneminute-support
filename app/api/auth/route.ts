import scalekit from "@/lib/scalekit";
import { assertScalekitEnv } from "@/lib/scalekit-env";
import crypto from "crypto";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    assertScalekitEnv();

    const state = crypto.randomBytes(16).toString("hex");
    (await cookies()).set("sk_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10,
    });

    const redirectUri = process.env.SCALEKIT_REDIRECT_URI!;
    const next = req.nextUrl.searchParams.get("next");
    const nextParam =
      next?.startsWith("/") && !next.startsWith("//") ? next : undefined;

    const options = {
      scopes: ["openid", "profile", "email", "offline_access"],
      state,
    };

    const authorizationUrl = scalekit.getAuthorizationUrl(redirectUri, options);

    const response = NextResponse.redirect(authorizationUrl);
    if (nextParam) {
      response.cookies.set("sk_next", nextParam, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 10,
      });
    }
    return response;
  } catch (error) {
    console.log(error);
    return NextResponse.json(
      { error: "Failed to generate authorization URL" },
      { status: 500 }
    );
  }
}
