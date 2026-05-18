import { db } from "@/db/client";
import { sections } from "@/db/schema";
import { isAuthorized } from "@/lib/isAuthorized";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const user = await isAuthorized();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();

    const { name, description, tone, allowedTopics, blockedTopics, sourceIds } =
      body;

    if (!name || !description || !tone) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (!sourceIds || !Array.isArray(sourceIds) || sourceIds.length === 0) {
      return NextResponse.json(
        { error: "At least one source is required" },
        { status: 400 }
      );
    }

    const section = await db.insert(sections).values({
      user_email: user.email,
      name,
      description,
      source_ids: sourceIds,
      tone,
      allowed_topics: allowedTopics || null,
      blocked_topics: blockedTopics || null,
      status: "active",
    });

    return NextResponse.json(
      { message: "Section created successfully", section },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error creating section:", error);
    return NextResponse.json(
      { error: "Failed to create section" },
      { status: 500 }
    );
  }
}
