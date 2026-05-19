import { isAuthorized } from "@/lib/isAuthorized";
import { ingestSource } from "@/lib/rag/ingest";
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

    // ---- multipart: PDF or CSV upload ----
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const type = formData.get("type") as string;

      if (type !== "upload") {
        return NextResponse.json(
          { error: "multipart requires type=upload" },
          { status: 400 }
        );
      }

      const file = formData.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }

      const fileName = file.name;
      const lower = fileName.toLowerCase();
      const isPdf = lower.endsWith(".pdf") || file.type === "application/pdf";
      const isCsv = lower.endsWith(".csv") || file.type === "text/csv";

      if (!isPdf && !isCsv) {
        return NextResponse.json(
          { error: "Only CSV and PDF files are allowed" },
          { status: 400 }
        );
      }

      const bytes = Buffer.from(await file.arrayBuffer());

      try {
        await ingestSource({
          type: isPdf ? "pdf" : "csv",
          userEmail: user.email,
          fileName,
          bytes,
          fileSize: file.size,
        });
      } catch (err) {
        // Map known PDF errors to user-friendly messages
        if (err instanceof PdfEncryptedError) {
          return NextResponse.json(
            { error: "This PDF is password-protected. Please upload an unlocked version." },
            { status: 400 }
          );
        }
        if (err instanceof PdfTooLargeError) {
          return NextResponse.json(
            { error: `PDF has ${err.pageCount} pages. Maximum supported is 30 pages — please split the file.` },
            { status: 400 }
          );
        }
        if (err instanceof PdfImageOnlyError) {
          return NextResponse.json(
            { error: "This PDF appears to be scanned or image-based. We can't extract text from it yet — please upload a text-based PDF." },
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

      return NextResponse.json(
        { message: `${isPdf ? "PDF" : "CSV"} uploaded successfully` },
        { status: 200 }
      );
    }

    // ---- JSON: website or text ----
    const body = await req.json();
    const type = body.type as string;

    if (type === "website") {
      const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY!}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: body.url, formats: ["markdown"] }),
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

      await ingestSource({
        type: "website",
        userEmail: user.email,
        url: body.url,
        markdown: json.data.markdown,
      });

      return NextResponse.json({ message: "Website added successfully" }, { status: 200 });
    }

    if (type === "text") {
      if (!body.content || !body.title) {
        return NextResponse.json(
          { error: "title and content are required" },
          { status: 400 }
        );
      }

      await ingestSource({
        type: "text",
        userEmail: user.email,
        title: body.title,
        content: body.content,
      });

      return NextResponse.json({ message: "Text added successfully" }, { status: 200 });
    }

    return NextResponse.json({ error: "unknown type" }, { status: 400 });
  } catch (error) {
    console.error("Error in knowledge store:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
