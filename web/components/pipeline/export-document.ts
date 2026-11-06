import { checkArtifact, checkSecrets, checkSource } from "./file-export/safety";

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "numbered"; marker: string; text: string }
  | { kind: "code"; lines: string[] }
  | { kind: "paragraph"; text: string }
  | { kind: "blank" };

const FENCE = /^\s*(`{3,}|~{3,})\s*[\w-]*\s*$/;
const HEADING = /^(#{1,3})\s+(.+?)(?:\s+#+)?\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.+)$/;
const NUMBERED = /^\s{0,3}(\d{1,3}[.)])\s+(.+)$/;

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let fence: { marker: string; lines: string[] } | null = null;
  for (const line of lines) {
    const fenceMatch = line.match(FENCE);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.marker[0] && fenceMatch[1].length >= fence.marker.length) {
        blocks.push({ kind: "code", lines: fence.lines });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1], lines: [] };
      continue;
    }
    if (!line.trim()) { blocks.push({ kind: "blank" }); continue; }
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      continue;
    }
    const bullet = line.match(BULLET);
    if (bullet) { blocks.push({ kind: "bullet", text: bullet[1] }); continue; }
    const numbered = line.match(NUMBERED);
    if (numbered) { blocks.push({ kind: "numbered", marker: numbered[1], text: numbered[2] }); continue; }
    blocks.push({ kind: "paragraph", text: line });
  }
  if (fence) blocks.push({ kind: "code", lines: fence.lines });
  return blocks;
}

const PDF_SPECIAL: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
  "\u2013": "-", "\u2014": "--", "\u2026": "...", "\u2022": "-", "\u00a0": " ",
};

// Standard PDF fonts only cover WinAnsi, so replace anything the built-in
// Helvetica/Courier encoding cannot represent instead of emitting broken glyphs.
function pdfText(text: string): string {
  let output = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === "\n") { output += char; continue; }
    if (char === "\t") { output += "    "; continue; }
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) { output += char; continue; }
    output += PDF_SPECIAL[char] ?? "?";
  }
  return output;
}

export function pdfReplacesCharacters(text: string): boolean {
  for (const char of text) {
    if (char === "\n" || char === "\t") continue;
    const code = char.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) continue;
    if (!(char in PDF_SPECIAL)) return true;
  }
  return false;
}

function safeName(name: string, extension: string): string {
  const base = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ")
    .replace(/[. ]+$/, "").slice(0, 80) || "pipeline-output";
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${base}-${date}.${extension}`;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function createPdfBlob(text: string): Promise<Blob> {
  checkSource(text);
  checkSecrets([text]);
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 54;
  const width = pageWidth - margin * 2;
  let y = margin;
  const ensureSpace = (height: number) => {
    if (y + height <= pageHeight - margin) return;
    doc.addPage();
    y = margin;
  };
  const write = (value: string, x: number, lineWidth: number, options: {
    font: "helvetica" | "courier"; style: "normal" | "bold"; size: number; lineHeight: number;
  }) => {
    doc.setFont(options.font, options.style);
    doc.setFontSize(options.size);
    const lines = doc.splitTextToSize(pdfText(value), lineWidth) as string[];
    for (const line of lines) {
      ensureSpace(options.lineHeight);
      doc.text(line, x, y);
      y += options.lineHeight;
    }
  };
  const blocks = parseBlocks(text);
  blocks.forEach((block, index) => {
    switch (block.kind) {
      case "heading": {
        if (y > margin) y += index === 0 ? 0 : 10;
        const size = block.level === 1 ? 18 : block.level === 2 ? 14.5 : 12;
        write(block.text, margin, width, { font: "helvetica", style: "bold", size, lineHeight: size * 1.35 });
        y += 6;
        break;
      }
      case "bullet":
        write(`- ${block.text}`, margin + 12, width - 12, { font: "helvetica", style: "normal", size: 11, lineHeight: 15.5 });
        break;
      case "numbered":
        write(`${block.marker} ${block.text}`, margin + 12, width - 12, { font: "helvetica", style: "normal", size: 11, lineHeight: 15.5 });
        break;
      case "code":
        for (const line of block.lines.length ? block.lines : [""]) {
          write(line || " ", margin + 10, width - 10, { font: "courier", style: "normal", size: 9, lineHeight: 12 });
        }
        y += 6;
        break;
      case "paragraph":
        write(block.text, margin, width, { font: "helvetica", style: "normal", size: 11, lineHeight: 15.5 });
        break;
      case "blank":
        y += 8;
        break;
    }
  });
  const total = doc.getNumberOfPages();
  for (let page = 1; page <= total; page++) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`${page} / ${total}`, pageWidth / 2, pageHeight - 26, { align: "center" });
  }
  return checkArtifact(doc.output("blob"));
}

export async function downloadPdf(text: string, name: string): Promise<void> {
  saveBlob(await createPdfBlob(text), safeName(name, "pdf"));
}

export async function createDocxBlob(text: string): Promise<Blob> {
  checkSource(text);
  checkSecrets([text]);
  const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import("docx");
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const;
  const children = parseBlocks(text).map((block) => {
    switch (block.kind) {
      case "heading":
        return new Paragraph({ text: block.text, heading: headings[block.level - 1], spacing: { before: 240, after: 120 } });
      case "bullet":
        return new Paragraph({ text: block.text, bullet: { level: 0 } });
      case "numbered":
        return new Paragraph({
          children: [new TextRun({ text: `${block.marker} ${block.text}` })],
          indent: { left: 720, hanging: 360 },
          spacing: { after: 120 },
        });
      case "code":
        return new Paragraph({
          children: [new TextRun({ text: (block.lines.length ? block.lines : [""]).join("\n"), font: "Consolas", size: 18 })],
          spacing: { before: 120, after: 180 },
        });
      case "paragraph":
        return new Paragraph({ text: block.text, spacing: { after: 120 } });
      case "blank":
        return new Paragraph({});
    }
  });
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{
      properties: { page: { margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
      children,
    }],
  });
  return checkArtifact(await Packer.toBlob(doc));
}

export async function downloadDocx(text: string, name: string): Promise<void> {
  saveBlob(await createDocxBlob(text), safeName(name, "docx"));
}
