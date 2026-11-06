export const EXPORT_LIMITS = {
  sourceChars: 131072, sourceBytes: 524288, blocks: 256, lines: 2048, lineChars: 8192,
  slides: 32, slideChars: 2500, titleChars: 120, sheets: 8, rows: 1000, columns: 32,
  cells: 10000, cellChars: 2048, svgLines: 160, artifactBytes: 4 * 1024 * 1024,
  specDepth: 12, jsonNodes: 20000, files: 16, bundleBytes: 16 * 1024 * 1024,
} as const;

export const OUTPUT_FORMATS = ["pdf", "docx", "pptx", "xlsx", "csv", "html", "md", "txt", "json", "svg"] as const;
export type OutputFormat = typeof OUTPUT_FORMATS[number];
export const DOWNLOAD_FORMATS = [...OUTPUT_FORMATS, "zip"] as const;
export type DownloadFormat = typeof DOWNLOAD_FORMATS[number];
/** Formats offered in the download picker. SVG remains supported by the artifact layer but is hidden from the UI. */
export const VISIBLE_DOWNLOAD_FORMATS = DOWNLOAD_FORMATS.filter((format) => format !== "svg");
export type CellValue = string | number | boolean | null;
export type ExportBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string; language?: string }
  | { type: "table"; rows: CellValue[][] };
export type ExportSlide = { title: string; blocks: ExportBlock[] };
export type ExportSheet = { name: string; rows: CellValue[][] };
export type ExportData = { title: string; blocks: ExportBlock[]; slides?: ExportSlide[]; sheets?: ExportSheet[] };

export class FileExportError extends Error {
  constructor(message: string) { super(message); this.name = "FileExportError"; }
}
