import { db } from "@/db/client";
import { knowledge_source } from "@/db/schema";
import { isAuthorized } from "@/lib/isAuthorized";
import { summarizeMarkdown } from "@/lib/openAI";
import { extractPdfText } from "@/lib/pdf/extractPdf";
import {
  PdfCorruptError,
  PdfEncryptedError,
  PdfImageOnlyError,
  PdfTooLargeError,
} from "@/lib/pdf/errors";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
export const runtime = "nodejs";

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

        const fileName = file.name;
        const lowerName = fileName.toLowerCase();
        const isPdf =
          lowerName.endsWith(".pdf") || file.type === "application/pdf";
        const isCsv =
          lowerName.endsWith(".csv") || file.type === "text/csv";

        if (isPdf) {
          const buffer = Buffer.from(await file.arrayBuffer());

          let extracted: { text: string; pageCount: number };
          try {
            extracted = await extractPdfText(buffer);
          } catch (err) {
            if (err instanceof PdfEncryptedError) {
              return NextResponse.json(
                {
                  error:
                    "This PDF is password-protected. Please upload an unlocked version.",
                },
                { status: 400 }
              );
            }
            if (err instanceof PdfTooLargeError) {
              return NextResponse.json(
                {
                  error: `PDF has ${err.pageCount} pages. Maximum supported is 30 pages — please split the file.`,
                },
                { status: 400 }
              );
            }
            if (err instanceof PdfImageOnlyError) {
              return NextResponse.json(
                {
                  error:
                    "This PDF appears to be scanned or image-based. We can't extract text from it yet — please upload a text-based PDF.",
                },
                { status: 400 }
              );
            }
            if (err instanceof PdfCorruptError) {
              return NextResponse.json(
                { error: "Could not read this PDF. The file may be corrupted." },
                { status: 400 }
              );
            }
            throw err;
          }

          const content =
            extracted.text.length > 8000
              ? await summarizeMarkdown(extracted.text)
              : extracted.text;

          await db.insert(knowledge_source).values({
            user_email: user.email,
            type: "upload",
            name: fileName,
            status: "active",
            content,
            meta_data: JSON.stringify({
              fileName,
              fileSize: file.size,
              pageCount: extracted.pageCount,
              fileType: "pdf",
            }),
          });

          return NextResponse.json(
            { message: "PDF uploaded successfully" },
            { status: 200 }
          );
        }

        if (isCsv) {
          const fileContent = await file.text();
          const lines = fileContent.split("\n").filter((line) => line.trim());
          const headers = lines[0]?.split(",").map((h) => h.trim());
          const markdown = await summarizeMarkdown(fileContent);

          await db.insert(knowledge_source).values({
            user_email: user.email,
            type: "upload",
            name: fileName,
            status: "active",
            content: markdown,
            meta_data: JSON.stringify({
              fileName,
              fileSize: file.size,
              rowCount: lines.length - 1,
              headers,
              fileType: "csv",
            }),
          });

          return NextResponse.json(
            { message: "CSV file uploaded successfully" },
            { status: 200 }
          );
        }

        return NextResponse.json(
          { error: "Only CSV and PDF files are allowed" },
          { status: 400 }
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
