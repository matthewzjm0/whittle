import { EXPORT_LIMITS, FileExportError, OUTPUT_FORMATS } from "./model";
import type { CellValue, ExportBlock, ExportData, ExportSheet, ExportSlide, OutputFormat } from "./model";
import { validateExportFilename } from "./filenames";
import { blockStrings, checkSource } from "./safety";

export type SingleExportSpec =
  | { exportVersion: 1; kind: "document"; title?: string; blocks: ExportBlock[] }
  | { exportVersion: 1; kind: "slides"; title?: string; slides: ExportSlide[] }
  | { exportVersion: 1; kind: "sheets"; title?: string; sheets: ExportSheet[] };

export type FilesExportSpec = {
  exportVersion: 1;
  kind: "files";
  title?: string;
  files: { name: string; format: OutputFormat; content: SingleExportSpec }[];
};

export type ExportSpec = SingleExportSpec | FilesExportSpec;

function checkUnicode(text: string): void {
  // Tabs and line breaks are inert text; other C0/C1 controls are not exportable.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\uFFFE\uFFFF]/.test(text)) {
    throw new FileExportError("Export JSON contains unsupported decoded control characters.");
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new FileExportError("Export JSON contains unpaired Unicode surrogates.");
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new FileExportError("Export JSON contains unpaired Unicode surrogates.");
    }
  }
}

function stringValue(value: unknown, max: number = EXPORT_LIMITS.sourceChars): string {
  if (typeof value !== "string") throw new FileExportError("Export specification requires a text value.");
  if (value.length > max) throw new FileExportError("Export specification text exceeds its character limit.");
  checkUnicode(value);
  return value;
}

function record(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FileExportError("Export specification requires an object.");
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new FileExportError("Export specification contains unknown fields.");
  if (required.some((key) => !Object.hasOwn(object, key))) throw new FileExportError("Export specification is missing required fields.");
  return object;
}

function array(value: unknown, max: number, empty = false): unknown[] {
  if (!Array.isArray(value) || (!empty && !value.length) || value.length > max) {
    throw new FileExportError("Export specification array is empty or exceeds its item limit.");
  }
  return value;
}

// Scan before JSON.parse allocates a tree. Keys count as nodes, and root container depth is 1.
// Grammar errors are left to JSON.parse, but scanning continues so late reserved keys cannot hide them.
function inspectJson(text: string): boolean {
  type Frame = { opener: string; keys: Set<string>; key: boolean; count: number; next: boolean };
  const stack: Frame[] = [];
  let nodes = 0;
  let recognized = false;
  const whitespace = (char: string | undefined) => char !== undefined && /[ \t\r\n]/.test(char);
  const node = () => {
    if (++nodes > EXPORT_LIMITS.jsonNodes) throw new FileExportError("Export JSON exceeds the 20000-node limit.");
  };
  const element = () => {
    const frame = stack.at(-1);
    if (frame?.opener === "[" && frame.next) {
      if (++frame.count > EXPORT_LIMITS.cells) throw new FileExportError("Export JSON array exceeds the 10000-item limit.");
      frame.next = false;
    }
  };
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (whitespace(char)) { i++; continue; }
    if (char === "{" || char === "[") {
      node(); element();
      if (stack.length >= EXPORT_LIMITS.specDepth) throw new FileExportError("Export JSON exceeds the maximum depth of 12.");
      stack.push({ opener: char, keys: new Set(), key: true, count: 0, next: true });
      i++; continue;
    }
    if (char === "}" || char === "]") {
      const frame = stack.at(-1);
      if (frame?.opener === (char === "}" ? "{" : "[")) stack.pop();
      i++; continue;
    }
    if (char === "," || char === ":") {
      const frame = stack.at(-1);
      if (char === "," && frame) { frame.next = true; frame.key = true; }
      i++; continue;
    }
    if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      if (i < text.length) i++;
      let decoded: unknown;
      try { decoded = JSON.parse(text.slice(start, i)); } catch { /* The complete grammar check follows. */ }
      let after = i;
      while (whitespace(text[after])) after++;
      node();
      if (typeof decoded === "string") {
        checkUnicode(decoded);
        const frame = stack.at(-1);
        if (text[after] === ":" || (frame?.opener === "{" && frame.key)) {
          if (["__proto__", "prototype", "constructor"].includes(decoded)) throw new FileExportError("Export JSON contains a forbidden object key.");
          if (frame?.opener === "{") {
            frame.key = false;
            if (frame.keys.has(decoded)) throw new FileExportError("Export JSON contains duplicate object keys.");
            frame.keys.add(decoded);
            if (stack.length === 1 && text[0] === "{" && (decoded === "exportVersion" || decoded === "kind")) recognized = true;
          }
        } else element();
      } else element();
      continue;
    }
    const start = i++;
    while (i < text.length && !whitespace(text[i]) && !/[{}\[\],:"]/.test(text[i])) i++;
    const token = text.slice(start, i);
    node(); element();
    let after = i;
    while (whitespace(text[after])) after++;
    const frame = stack.at(-1);
    if (stack.length === 1 && frame?.opener === "{" && (frame.key || text[after] === ":") && (token === "exportVersion" || token === "kind")) recognized = true;
    if (frame?.opener === "{") frame.key = false;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token) && !Number.isFinite(Number(token))) {
      throw new FileExportError("Export JSON numbers must be finite.");
    }
  }
  return recognized;
}

export function parseExportSpec(source: string): ExportSpec | undefined {
  checkSource(source);
  let text = source.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  const fence = text.match(/^```json[ \t]*\r?\n([\s\S]*)\r?\n```$/i);
  if (fence) text = fence[1].replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  else if (!/^[{["\d-]|^(?:true|false|null)(?:[ \t\r\n]|$)/.test(text)) return undefined;
  const recognized = inspectJson(text);
  let decoded: unknown;
  try { decoded = JSON.parse(text); }
  catch {
    if (recognized) throw new FileExportError("Invalid JSON in export specification.");
    return undefined;
  }
  if (!recognized) return undefined;

  const budget = { blocks: 0, cells: 0, slides: 0, sheets: 0 };
  function rows(value: unknown): CellValue[][] {
    const input = array(value, EXPORT_LIMITS.rows);
    let width = 0;
    return input.map((row, index) => {
      const cells = array(row, EXPORT_LIMITS.columns);
      if (!index) width = cells.length;
      if (cells.length !== width) throw new FileExportError("Export tables must be rectangular with 1-32 columns.");
      budget.cells += cells.length;
      if (budget.cells > EXPORT_LIMITS.cells) throw new FileExportError("Export specification exceeds 10000 cells in total.");
      return cells.map((cell) => {
        if (typeof cell === "string") return stringValue(cell, EXPORT_LIMITS.cellChars);
        if (cell === null || typeof cell === "boolean" || (typeof cell === "number" && Number.isFinite(cell))) return cell;
        throw new FileExportError("Export cells must be text, finite numbers, booleans, or null; formula objects are not supported.");
      });
    });
  }
  function table(): void {
    if (++budget.sheets > EXPORT_LIMITS.sheets) throw new FileExportError("Export specification exceeds 8 sheets/tables in total.");
  }
  function blocks(value: unknown, slideBody = false): ExportBlock[] {
    const input = array(value, EXPORT_LIMITS.blocks, slideBody);
    budget.blocks += input.length;
    if (budget.blocks > EXPORT_LIMITS.blocks) throw new FileExportError("Export specification exceeds 256 content blocks in total.");
    return input.map((value): ExportBlock => {
      const block = record(value, ["type", "level", "text", "ordered", "items", "language", "rows"], ["type"]);
      switch (block.type) {
        case "heading": {
          record(block, ["type", "level", "text"], ["type", "level", "text"]);
          if (slideBody) throw new FileExportError("Slide body blocks cannot contain headings. Use the slide title instead.");
          if (typeof block.level !== "number" || !Number.isInteger(block.level) || block.level < 1 || block.level > 6) {
            throw new FileExportError("Export heading levels must be integers from 1 to 6.");
          }
          return { type: "heading", level: block.level, text: stringValue(block.text, EXPORT_LIMITS.titleChars) };
        }
        case "paragraph":
          record(block, ["type", "text"], ["type", "text"]);
          return { type: "paragraph", text: stringValue(block.text) };
        case "list":
          record(block, ["type", "ordered", "items"], ["type", "ordered", "items"]);
          if (typeof block.ordered !== "boolean") throw new FileExportError("Export list ordered must be a boolean.");
          return { type: "list", ordered: block.ordered, items: array(block.items, EXPORT_LIMITS.lines).map((item) => stringValue(item)) };
        case "code":
          record(block, ["type", "text", "language"], ["type", "text"]);
          return { type: "code", text: stringValue(block.text), ...(Object.hasOwn(block, "language") ? { language: stringValue(block.language, EXPORT_LIMITS.titleChars) } : {}) };
        case "table":
          record(block, ["type", "rows"], ["type", "rows"]);
          table();
          return { type: "table", rows: rows(block.rows) };
        default: throw new FileExportError("Unsupported export block type.");
      }
    });
  }
  function single(value: unknown): SingleExportSpec {
    const object = record(value, ["exportVersion", "kind", "title", "blocks", "slides", "sheets"], ["exportVersion", "kind"]);
    if (object.exportVersion !== 1) throw new FileExportError("Export specification requires exportVersion 1.");
    const title = Object.hasOwn(object, "title") ? { title: stringValue(object.title, EXPORT_LIMITS.titleChars) } : {};
    switch (object.kind) {
      case "document":
        record(object, ["exportVersion", "kind", "title", "blocks"], ["exportVersion", "kind", "blocks"]);
        return { exportVersion: 1, kind: "document", ...title, blocks: blocks(object.blocks) };
      case "slides": {
        record(object, ["exportVersion", "kind", "title", "slides"], ["exportVersion", "kind", "slides"]);
        const input = array(object.slides, EXPORT_LIMITS.slides);
        budget.slides += input.length;
        if (budget.slides > EXPORT_LIMITS.slides) throw new FileExportError("Export specification exceeds 32 slides in total.");
        const slides = input.map((value) => {
          const slide = record(value, ["title", "blocks"], ["title", "blocks"]);
          const title = stringValue(slide.title, EXPORT_LIMITS.titleChars);
          if (!title.trim()) throw new FileExportError("Each export slide requires a nonempty title.");
          const body = blocks(slide.blocks, true);
          if (blockStrings(body).join("\n").length > EXPORT_LIMITS.slideChars) throw new FileExportError("Export slide body exceeds 2500 characters.");
          return { title, blocks: body };
        });
        return { exportVersion: 1, kind: "slides", ...title, slides };
      }
      case "sheets": {
        record(object, ["exportVersion", "kind", "title", "sheets"], ["exportVersion", "kind", "sheets"]);
        const names = new Set<string>();
        const sheets = array(object.sheets, EXPORT_LIMITS.sheets).map((value) => {
          const sheet = record(value, ["name", "rows"], ["name", "rows"]);
          const name = stringValue(sheet.name, 31);
          const canonical = name.normalize("NFC").toLowerCase();
          if (!name.trim() || canonical.length > 31 || /[:\\/?*\[\]\x00-\x1f\x7f]|^'|'$/.test(name)) throw new FileExportError("Sheet names must contain 1-31 safe characters.");
          if (names.has(canonical)) throw new FileExportError("Sheet names must be unique ignoring case and Unicode normalization.");
          names.add(canonical);
          table();
          return { name, rows: rows(sheet.rows) };
        });
        return { exportVersion: 1, kind: "sheets", ...title, sheets };
      }
      default: throw new FileExportError("Unsupported single-file export specification kind.");
    }
  }

  let spec: ExportSpec;
  if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) && (decoded as Record<string, unknown>).kind === "files") {
    const object = record(decoded, ["exportVersion", "kind", "title", "files"], ["exportVersion", "kind", "files"]);
    if (object.exportVersion !== 1) throw new FileExportError("Export specification requires exportVersion 1.");
    const names = new Set<string>();
    const files = array(object.files, EXPORT_LIMITS.files).map((value) => {
      const file = record(value, ["name", "format", "content"], ["name", "format", "content"]);
      if (typeof file.format !== "string" || !(OUTPUT_FORMATS as readonly string[]).includes(file.format)) throw new FileExportError("Unsupported export file format. ZIP files are not supported in a manifest.");
      const format = file.format as OutputFormat;
      const name = validateExportFilename(stringValue(file.name, 80), format);
      if (names.has(name.toLowerCase())) throw new FileExportError("Export filenames must be unique ignoring case.");
      names.add(name.toLowerCase());
      return { name, format, content: single(file.content) };
    });
    spec = { exportVersion: 1, kind: "files", ...(Object.hasOwn(object, "title") ? { title: stringValue(object.title, EXPORT_LIMITS.titleChars) } : {}), files };
  } else spec = single(decoded);
  // Count actual decoded line breaks, not artificial separators between cells or fields.
  let chars = 0;
  let bytes = 0;
  let breaks = 0;
  const encoder = new TextEncoder();
  for (const part of specStrings(spec)) {
    chars += part.length;
    bytes += encoder.encode(part).length;
    const lines = part.split(/\r\n?|\n/);
    breaks += lines.length - 1;
    if (chars > EXPORT_LIMITS.sourceChars || bytes > EXPORT_LIMITS.sourceBytes) throw new FileExportError("Decoded export text exceeds 131072 characters or 512 KiB.");
    if (breaks >= EXPORT_LIMITS.lines || lines.some((line) => line.length > EXPORT_LIMITS.lineChars)) throw new FileExportError("Decoded export text exceeds 2048 lines or 8192 characters per line.");
  }
  return spec;
}

export function specData(spec: SingleExportSpec, fallbackTitle: string): ExportData {
  const title = stringValue(spec.title ?? fallbackTitle, EXPORT_LIMITS.titleChars);
  const copyBlocks = (blocks: ExportBlock[]): ExportBlock[] => blocks.map((block): ExportBlock => block.type === "table"
    ? { type: "table", rows: block.rows.map((row) => [...row]) } : block.type === "list"
      ? { type: "list", ordered: block.ordered, items: [...block.items] } : { ...block });
  if (spec.kind === "document") return { title, blocks: copyBlocks(spec.blocks) };
  // Non-Office renderers need document blocks as well as the native slide/sheet representation.
  if (spec.kind === "slides") {
    const slides = spec.slides.map((slide) => ({ title: slide.title, blocks: copyBlocks(slide.blocks) }));
    return { title, slides, blocks: slides.flatMap((slide): ExportBlock[] => [{ type: "heading", level: 1, text: slide.title }, ...copyBlocks(slide.blocks)]) };
  }
  const sheets = spec.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.map((row) => [...row]) }));
  return { title, sheets, blocks: sheets.flatMap((sheet): ExportBlock[] => [{ type: "heading", level: 1, text: sheet.name }, { type: "table", rows: sheet.rows.map((row) => [...row]) }]) };
}

export function specStrings(spec: ExportSpec): string[] {
  const parts = spec.title === undefined ? [] : [spec.title];
  if (spec.kind === "files") for (const file of spec.files) parts.push(file.name, ...specStrings(file.content));
  else if (spec.kind === "document") parts.push(...blockStrings(spec.blocks));
  else if (spec.kind === "slides") for (const slide of spec.slides) parts.push(slide.title, ...blockStrings(slide.blocks));
  else for (const sheet of spec.sheets) parts.push(sheet.name, ...sheet.rows.flatMap((row) => row.map((cell) => cell === null ? "" : String(cell))));
  return parts;
}
