import { EXPORT_LIMITS, FileExportError, DOWNLOAD_FORMATS, OUTPUT_FORMATS } from "./model";
import type { DownloadFormat, ExportData, OutputFormat } from "./model";
import { contentSheets, contentText, parseExportMarkdown } from "./content";
import { checkArtifact, checkData, checkSecrets, checkSource, safeCell } from "./safety";
import { parseExportSpec, specData, specStrings } from "./spec";

export function escapeMarkup(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function htmlDocument(data: ExportData): string {
  const body = data.blocks.map((block) => {
    if (block.type === "heading") {
      if (!Number.isInteger(block.level) || block.level < 1 || block.level > 6) throw new FileExportError("HTML heading levels must be integers from 1 to 6.");
      return `<h${block.level}>${escapeMarkup(block.text)}</h${block.level}>`;
    }
    if (block.type === "list") return `<${block.ordered ? "ol" : "ul"}>${block.items.map((item) => `<li>${escapeMarkup(item)}</li>`).join("")}</${block.ordered ? "ol" : "ul"}>`;
    if (block.type === "table") return `<table>${block.rows.map((row, index) => `<tr>${row.map((cell) => `<${index ? "td" : "th"}>${escapeMarkup(cell === null ? "" : String(cell))}</${index ? "td" : "th"}>`).join("")}</tr>`).join("")}</table>`;
    return block.type === "code" ? `<pre><code>${escapeMarkup(block.text)}</code></pre>` : `<p>${escapeMarkup(block.text).replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; sandbox"><title>${escapeMarkup(data.title)}</title><style>body{max-width:70em;margin:2em auto;padding:1em;font:16px system-ui;overflow-wrap:anywhere}table{border-collapse:collapse}td,th{border:1px solid;padding:.4em}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}

function svgDocument(data: ExportData): string {
  const lines: string[] = [];
  for (const line of contentText(data).split("\n")) {
    const chars = Array.from(line);
    for (let i = 0; i < Math.max(1, chars.length); i += 64) lines.push(chars.slice(i, i + 64).join(""));
    if (lines.length > EXPORT_LIMITS.svgLines) throw new FileExportError("SVG exceeds 160 wrapped lines. Use another format or shorten the output.");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${lines.length * 24 + 40}" viewBox="0 0 1000 ${lines.length * 24 + 40}"><title>${escapeMarkup(data.title)}</title><rect width="100%" height="100%" fill="white"/><text fill="black" font-family="monospace" font-size="14" xml:space="preserve">${lines.map((line, index) => `<tspan x="20" y="${index * 24 + 30}">${escapeMarkup(line)}</tspan>`).join("")}</text></svg>`;
}

async function createDataArtifactUnchecked(data: ExportData, format: OutputFormat): Promise<Blob> {
  if (format === "pptx" || format === "xlsx") return (await import("./office")).createOfficeBlob(format, data);
  if (format === "pdf" || format === "docx") {
    const library = await import("../export-document");
    return format === "pdf" ? library.createPdfBlob(contentText(data, true)) : library.createDocxBlob(contentText(data, true));
  }
  if (format === "csv") {
    const sheets = contentSheets(data);
    if (sheets.length !== 1) throw new FileExportError("CSV supports one sheet/table. Choose XLSX for multiple sheets.");
    const csv = sheets[0].rows.map((row) => row.map((cell) => `"${String(safeCell(cell) ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    return new Blob([csv], { type: "text/csv;charset=utf-8" });
  }
  if (format === "html") return new Blob([htmlDocument(data)], { type: "text/html;charset=utf-8" });
  if (format === "svg") return new Blob([svgDocument(data)], { type: "image/svg+xml;charset=utf-8" });
  if (format === "json") return new Blob([JSON.stringify({ exportVersion: 1, kind: "document", title: data.title, blocks: data.blocks }, null, 2)], { type: "application/json" });
  return new Blob([contentText(data, format === "md")], { type: "text/plain;charset=utf-8" });
}

export async function createDataArtifact(data: ExportData, format: OutputFormat, secrets: readonly string[] = []): Promise<Blob> {
  if (!(OUTPUT_FORMATS as readonly string[]).includes(format)) throw new FileExportError("Unsupported export format.");
  checkData(data, secrets);
  return checkArtifact(await createDataArtifactUnchecked(data, format));
}

export async function createOutputArtifact(source: string, format: DownloadFormat, title = "Pipeline output", secrets: readonly string[] = []) {
  if (!(DOWNLOAD_FORMATS as readonly string[]).includes(format)) throw new FileExportError("Unsupported export format.");
  checkSource(source);
  checkSecrets([source, title], secrets);
  const spec = parseExportSpec(source);
  if (spec) checkSecrets(specStrings(spec), secrets);
  if (spec?.kind === "files") {
    if (format === "zip") {
      const { createZipArtifact } = await import("./zip");
      return { blob: await createZipArtifact(spec, secrets, createDataArtifact), filename: "pipeline-output.zip" };
    }
    if (format !== "json") throw new FileExportError("ZIP required for multi-file output. Choose ZIP for a bundle or JSON for the validated manifest.");
    return { blob: checkArtifact(new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" })), filename: "pipeline-output.json" };
  }
  if (format === "zip") throw new FileExportError("ZIP export requires a files specification with named files.");
  const data = spec ? specData(spec, title) : parseExportMarkdown(source, title);
  checkData(data, secrets);
  const blob = checkArtifact(spec && format === "json" ? new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" }) : await createDataArtifact(data, format));
  return { blob, filename: `pipeline-output.${format}` };
}

export function downloadArtifact(blob: Blob, filename: string): void {
  checkArtifact(blob);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try { link.href = url; link.download = filename; document.body.appendChild(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
