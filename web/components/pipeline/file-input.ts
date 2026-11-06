const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PAGES = 100;

/** Extract text locally; the resulting text is only sent when the user sends the message. */
export async function extractFileText(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new Error("File exceeds the 5 MB upload limit.");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (["txt", "md", "csv"].includes(extension ?? "")) {
    return await file.text();
  }
  if (extension === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`PDF exceeds the ${MAX_PDF_PAGES}-page limit.`);
      const pages: string[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join(""));
        page.cleanup();
      }
      const text = pages.join("\n\n").trim();
      if (!text) throw new Error("No extractable text found. This PDF may be scanned; OCR is not supported.");
      return text;
    } finally { await task.destroy(); }
  }
  throw new Error("Unsupported file. Choose a PDF, DOCX, TXT, Markdown, or CSV file.");
}
