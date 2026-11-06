import { parseExportMarkdown } from "./file-export/content";
import type { DownloadFormat } from "./file-export/model";
import { parseExportSpec } from "./file-export/spec";

export function suggestOutputFormat(text: string): DownloadFormat {
  const spec = parseExportSpec(text);
  if (spec) {
    if (spec.kind === "files") return "zip";
    if (spec.kind === "slides") return "pptx";
    if (spec.kind === "sheets") return "xlsx";
    return "docx";
  }
  const blocks = parseExportMarkdown(text, "Pipeline output").blocks;
  const tables = blocks.filter((block) => block.type === "table").length;
  if (tables) return tables === 1 ? "csv" : "xlsx";
  if (blocks.filter((block) => block.type === "heading" && block.level === 1).length > 1) return "pptx";
  return "docx";
}
