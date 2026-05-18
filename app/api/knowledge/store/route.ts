import { db } from "@/db/client";
import { knowledge_source } from "@/db/schema";
import { isAuthorized } from "@/lib/isAuthorized";
import { summarizeMarkdown } from "@/lib/openAI";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const user = await isAuthorized();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contentType = req.headers.get("content-type") || "";
    let type: string;
    let body: any = {};

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      type = formData.get("type") as string;

      if (type === "upload") {
        const file = formData.get("file") as File;

        if (!file) {
          return NextResponse.json(
            { error: "No file provided" },
            { status: 400 }
          );
        }

        const fileContent = await file.text();

        const lines = fileContent.split("\n").filter((line) => line.trim());
        const headers = lines[0]?.split(",").map((h) => h.trim());
        let formattedContent: any = "";

        const markdown = await summarizeMarkdown(fileContent);
        formattedContent = markdown;

        await db.insert(knowledge_source).values({
          user_email: user.email,
          type: "upload",
          name: file.name,
          status: "active",
          content: formattedContent,
          meta_data: JSON.stringify({
            fileName: file.name,
            fileSize: file.size,
            rowCount: lines.length - 1,
            headers: headers,
          }),
        });

        return NextResponse.json(
          { message: "CSV file uploaded successfully" },
          { status: 200 }
        );
      }
    } else {
      body = await req.json();
      type = body.type;
    }
    if (type === "website") {
      const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY!}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: body.url,
          formats: ["markdown"],
        }),
      });

      const json = (await res.json().catch(() => null)) as
        | { success: true; data: { markdown: string } }
        | { success: false; error?: string }
        | null;

      if (!res.ok || !json || json.success !== true) {
        return NextResponse.json(
          {
            error: "Firecrawl request failed",
            status: res.status,
            message: (json && !json.success && json.error) || "Unknown Firecrawl error",
          },
          { status: 502 }
        );
      }

      const markdown = await summarizeMarkdown(json.data.markdown);

      await db.insert(knowledge_source).values({
        user_email: user.email,
        type: "website",
        name: body.url,
        status: "active",
        source_url: body.url,
        content: markdown,
      });
    } else if (type === "text") {
      let content = body.content;

      if (body.content.length > 500) {
        const markdown = await summarizeMarkdown(body.content);
        content = markdown;
      }

      await db.insert(knowledge_source).values({
        user_email: user.email,
        type: "text",
        name: body.title,
        status: "active",
        content: content,
      });
    }

    return NextResponse.json(
      { message: "Source added successfully" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error in knowledge store:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
