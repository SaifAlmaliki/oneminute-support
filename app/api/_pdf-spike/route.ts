import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;

    const firstPage = await doc.getPage(1);
    const textContent = await firstPage.getTextContent();
    const sample = textContent.items
      .map((item: any) => item.str)
      .join(" ")
      .slice(0, 200);

    await doc.destroy();

    return NextResponse.json({
      ok: true,
      pageCount,
      firstPageSample: sample,
      bufferBytes: buffer.length,
    });
  } catch (err: any) {
    console.error("[pdf-spike] error:", err);
    return NextResponse.json(
      { ok: false, name: err?.name, message: err?.message },
      { status: 500 }
    );
  }
}
