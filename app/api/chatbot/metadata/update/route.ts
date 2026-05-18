import { db } from "@/db/client";
import { chatBotMetadata } from "@/db/schema";
import { isAuthorized } from "@/lib/isAuthorized";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

const VALID_MODES = new Set(["text", "voice", "both"]);

export async function PUT(req: Request) {
  try {
    const user = await isAuthorized();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { color, welcome_message, mode } = body;

    if (!color || !welcome_message) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }
    if (mode !== undefined && !VALID_MODES.has(mode)) {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }

    const update: Record<string, unknown> = { color, welcome_message };
    if (mode !== undefined) update.mode = mode;

    const [updatedMetadata] = await db
      .update(chatBotMetadata)
      .set(update)
      .where(eq(chatBotMetadata.user_email, user.email!))
      .returning();

    return NextResponse.json(updatedMetadata, { status: 200 });
  } catch (error) {
    console.error("Failed to update chatbot metadata:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
