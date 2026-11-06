import { EXPORT_LIMITS, FileExportError } from "./model";
import type { CellValue, ExportBlock, ExportData, ExportSheet } from "./model";

export function checkSource(text: string): void {
  if (!text.trim()) throw new FileExportError("There is no output to export.");
  if (text.length > EXPORT_LIMITS.sourceChars || new TextEncoder().encode(text).length > EXPORT_LIMITS.sourceBytes) throw new FileExportError("Export input exceeds 131072 characters or 512 KiB.");
  checkText(text);
  const lines = text.split(/\r\n?|\n/);
  if (lines.length > EXPORT_LIMITS.lines || lines.some((line) => line.length > EXPORT_LIMITS.lineChars)) throw new FileExportError("Export input exceeds 2048 lines or 8192 characters per line.");
}

function checkText(text: string): void {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\uFFFE\uFFFF]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) throw new FileExportError("Export text contains unsupported controls or invalid Unicode.");
}

function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function checkSecrets(parts: string[], secrets: readonly string[] = []): void {
  const source = parts.join("");
  let decoded = source.normalize("NFKC").replace(/\\u([\da-f]{4})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (_, hex: string, decimal: string) => {
      const code = parseInt(hex || decimal, hex ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
  decoded = decoded.replace(/(?:%[\da-f]{2})+/gi, (part) => { try { return decodeURIComponent(part); } catch { return part; } });
  const compact = decoded.replace(/\s/g, "");
  const credential = /(?:sk-(?:or-v1-)?[a-z\d_-]{12,}|ntn_[a-z\d]{20,}|gh[pousr]_[a-z\d]{20,}|AKIA[A-Z\d]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|authorization\s*["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\b|(?:api[_ -]?key|access[_ -]?token|secret[_ -]?key|password)\s*["']?\s*[:=]\s*["']?\s*\S)/i;
  const knownSecret = secrets.some((secret) => {
    if (!secret) return false;
    const encoded = base64Utf8(secret);
    return source.includes(secret) || decoded.includes(secret) || compact.includes(secret.replace(/\s/g, ""))
      || source.includes(encoded) || decoded.includes(encoded) || compact.includes(encoded);
  });
  if (credential.test(decoded) || knownSecret) {
    throw new FileExportError("Export blocked: content may contain credentials. Remove secrets before exporting.");
  }
}

export function blockStrings(blocks: ExportBlock[]): string[] {
  return blocks.flatMap((block) => block.type === "list" ? block.items : block.type === "table"
    ? block.rows.flatMap((row) => row.map((cell) => cell === null ? "" : String(cell))) : block.type === "code" ? [block.language ?? "", block.text] : [block.text]);
}

export function checkData(data: ExportData, secrets: readonly string[] = []): void {
  if (data.title.length > EXPORT_LIMITS.titleChars) throw new FileExportError("Export title exceeds 120 characters.");
  const blocks = data.slides ? data.slides.flatMap((slide) => slide.blocks) : data.sheets ? [] : data.blocks;
  if (blocks.length > EXPORT_LIMITS.blocks) throw new FileExportError("Export exceeds 256 content blocks.");
  const tables = blocks.filter((block) => block.type === "table").map((block, index) => ({ name: `Table ${index + 1}`, rows: block.rows }));
  checkSheets(data.sheets ?? tables);
  const parts = [data.title, ...blockStrings(blocks), ...(data.slides ?? []).map((slide) => slide.title), ...(data.sheets ?? []).flatMap((sheet) => [sheet.name, ...sheet.rows.flatMap((row) => row.map((cell) => cell === null ? "" : String(cell)))])];
  let chars = 0, bytes = 0, breaks = 0;
  for (const part of parts) {
    checkText(part);
    chars += part.length; bytes += new TextEncoder().encode(part).length;
    const lines = part.split(/\r\n?|\n/); breaks += lines.length - 1;
    if (chars > EXPORT_LIMITS.sourceChars || bytes > EXPORT_LIMITS.sourceBytes) throw new FileExportError("Decoded export text exceeds 131072 characters or 512 KiB.");
    if (breaks >= EXPORT_LIMITS.lines || lines.some((line) => line.length > EXPORT_LIMITS.lineChars)) throw new FileExportError("Decoded export text exceeds 2048 lines or 8192 characters per line.");
  }
  checkSecrets(parts, secrets);
}

export function checkSheets(sheets: ExportSheet[]): void {
  if (sheets.length > EXPORT_LIMITS.sheets) throw new FileExportError("Export exceeds 8 sheets/tables.");
  let cells = 0;
  const names = new Set<string>();
  for (const sheet of sheets) {
    const name = sheet.name.normalize("NFC").toLowerCase();
    if (!name.trim() || name.length > 31 || /[:\\/?*\[\]\x00-\x1f\x7f]/.test(name) || /^'|'$/.test(name)) throw new FileExportError("Sheet names must contain 1-31 safe characters.");
    if (names.has(name)) throw new FileExportError("Sheet names must be unique ignoring case.");
    names.add(name);
    if (!sheet.rows.length || sheet.rows.length > EXPORT_LIMITS.rows) throw new FileExportError("Each sheet/table requires 1-1000 rows.");
    const width = sheet.rows[0].length;
    if (!width || width > EXPORT_LIMITS.columns || sheet.rows.some((row) => row.length !== width)) throw new FileExportError("Tables must be rectangular with 1-32 columns.");
    for (const row of sheet.rows) for (const cell of row) {
      if (!(cell === null || typeof cell === "string" || typeof cell === "boolean" || (typeof cell === "number" && Number.isFinite(cell)))) throw new FileExportError("Cells must be text, finite numbers, booleans, or null; formulas are not supported.");
      if (typeof cell === "string" && cell.length > EXPORT_LIMITS.cellChars) throw new FileExportError("A spreadsheet cell exceeds 2048 characters.");
    }
    cells += sheet.rows.length * width;
  }
  if (cells > EXPORT_LIMITS.cells) throw new FileExportError("Export exceeds 10000 spreadsheet cells.");
}

export function safeCell(cell: CellValue): CellValue {
  return typeof cell === "string" && (/^[\s\uFEFF]*[=+@-]/.test(cell) || /^[\t\r\n]/.test(cell)) ? `'${cell}` : cell;
}

export function checkArtifact(blob: Blob): Blob {
  if (!blob.size || blob.size > EXPORT_LIMITS.artifactBytes) throw new FileExportError("Generated file is empty or exceeds the 4 MiB export limit.");
  return blob;
}
