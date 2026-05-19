import { db } from "@/db/client";
import { knowledge_source } from "@/db/schema";
import { isAuthorized } from "@/lib/isAuthorized";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET() {
  const user = await isAuthorized();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sources = await db
    .select({
      id: knowledge_source.id,
      user_email: knowledge_source.user_email,
      type: knowledge_source.type,
      name: knowledge_source.name,
      status: knowledge_source.status,
      source_url: knowledge_source.source_url,
      blob_url: knowledge_source.blob_url,
      extraction_status: knowledge_source.extraction_status,
      extraction_error: knowledge_source.extraction_error,
      chunk_count: knowledge_source.chunk_count,
      meta_data: knowledge_source.meta_data,
      last_updated: knowledge_source.last_updated,
      created_at: knowledge_source.created_at,
    })
    .from(knowledge_source)
    .where(eq(knowledge_source.user_email, user.email));

  return NextResponse.json({ sources }, { status: 200 });
}
