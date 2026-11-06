import type PptxGenJS from "pptxgenjs";
import type { CellObject, SheetData } from "write-excel-file/browser";
import { contentSheets, contentSlides } from "./content";
import { EXPORT_LIMITS, FileExportError } from "./model";
import type { ExportData, ExportSlide } from "./model";
import { checkArtifact, checkData, safeCell } from "./safety";

const SLIDE_WIDTH = 12.33;
const BODY_TOP = 1.65;
const BODY_BOTTOM = 7.05;
const LAYOUT_ERROR = "PPTX layout exceeds slide space. Split content with headings, shorten code lines, or reduce table columns.";

type TextLayout = {
  kind: "text"; lines: string[]; y: number; h: number; fontSize: number;
  code: boolean; bullet?: PptxGenJS.TextPropsOptions["bullet"];
};
type TableLayout = { kind: "table"; rows: PptxGenJS.TableRow[]; heights: number[]; y: number; h: number; fontSize: number };

// Conservative Courier New widths include room for Unicode fallback glyphs and tabs.
function textLines(text: string, width: number, fontSize: number, wrap = true): string[] {
  const capacity = width * 72 / fontSize;
  const result: string[] = [];
  for (const sourceLine of text.split(/\r\n?|\n/)) {
    let line = "";
    let used = 0;
    for (const char of sourceLine) {
      const units = char === "\t" ? 8 : char.codePointAt(0)! <= 0x7e ? 0.7 : 1.2;
      if (units > capacity) throw new FileExportError(LAYOUT_ERROR);
      if (used + units > capacity) {
        if (!wrap) throw new FileExportError(LAYOUT_ERROR);
        result.push(line); line = ""; used = 0;
      }
      line += char; used += units;
    }
    result.push(line);
  }
  return result;
}

function slideLayout(slide: ExportSlide, fontSize: number): (TextLayout | TableLayout)[] {
  const result: (TextLayout | TableLayout)[] = [];
  let y = BODY_TOP;
  const addText = (text: string, code = false, bullet?: TextLayout["bullet"]) => {
    const lines = textLines(text, SLIDE_WIDTH - (bullet ? 0.5 : 0), fontSize, !code);
    const h = lines.length * fontSize * 1.3 / 72 + 0.06;
    result.push({ kind: "text", lines, y, h, fontSize, code, bullet });
    y += h + 0.08;
  };
  for (const block of slide.blocks) {
    if (block.type === "table") {
      const columns = block.rows[0]?.length ?? 0;
      if (!columns || columns > EXPORT_LIMITS.columns || !block.rows.length || block.rows.length > EXPORT_LIMITS.rows
        || block.rows.some((row) => row.length !== columns)) throw new FileExportError(LAYOUT_ERROR);
      const tableFont = Math.max(12, fontSize - 2);
      const heights: number[] = [];
      const rows = block.rows.map((row) => {
        const lines = row.map((cell) => textLines(cell === null ? "" : String(cell), SLIDE_WIDTH / columns - 0.12, tableFont));
        heights.push(Math.max(...lines.map((cell) => cell.length)) * tableFont * 1.3 / 72 + 0.12);
        return lines.map((cell) => ({ text: cell.join("\n") }));
      });
      const h = heights.reduce((sum, height) => sum + height, 0);
      result.push({ kind: "table", rows, heights, y, h, fontSize: tableFont });
      y += h + 0.08;
    } else if (block.type === "list") {
      block.items.forEach((item, index) => addText(item, false, block.ordered
        ? { type: "number", numberType: "arabicPeriod", numberStartAt: index + 1, indent: 18 }
        : { indent: 18 }));
    } else addText(block.text, block.type === "code");
    if (y - 0.08 > BODY_BOTTOM) throw new FileExportError(LAYOUT_ERROR);
  }
  return result;
}

async function createPptx(data: ExportData): Promise<Blob> {
  const slides = contentSlides(data).map((slide) => {
    const title = textLines(slide.title, SLIDE_WIDTH, 22);
    if (title.length > 3) throw new FileExportError("PPTX title layout exceeds three lines. Shorten the heading.");
    for (const fontSize of [16, 14, 12]) {
      try { return { title, items: slideLayout(slide, fontSize) }; }
      catch (error) { if (!(error instanceof FileExportError)) throw error; }
    }
    throw new FileExportError(LAYOUT_ERROR);
  });

  const { default: Pptx } = await import("pptxgenjs");
  const pptx = new Pptx();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = data.title;
  pptx.author = "Pipeline";
  pptx.subject = "Pipeline output";
  pptx.company = "";
  const base: PptxGenJS.TextPropsOptions = {
    x: 0.5, w: SLIDE_WIDTH, fontFace: "Courier New", color: "202020", margin: 0,
    valign: "top", fit: "none", wrap: false, paraSpaceBefore: 0, paraSpaceAfter: 0,
    tabStops: Array.from({ length: 24 }, (_, index) => ({ position: (index + 1) * 0.5 })),
  };
  for (const planned of slides) {
    const slide = pptx.addSlide();
    planned.title.forEach((text, index) => slide.addText(text, {
      ...base, y: 0.35 + index * 22 * 1.2 / 72, h: 22 * 1.2 / 72 + 0.06,
      fontSize: 22, bold: true, lineSpacingMultiple: 1.2,
    }));
    for (const item of planned.items) {
      if (item.kind === "table") {
        slide.addTable(item.rows, {
          x: 0.5, y: item.y, w: SLIDE_WIDTH, h: item.h, rowH: item.heights,
          colW: Array(item.rows[0].length).fill(SLIDE_WIDTH / item.rows[0].length),
          fontFace: "Courier New", fontSize: item.fontSize, color: "202020", margin: 0,
          border: { type: "solid", color: "AAAAAA", pt: 0.5 }, autoPage: false,
        });
      } else {
        // Separate line boxes avoid v4.0.1's repeated paragraph properties in multi-run text.
        item.lines.forEach((text, index) => {
          const continuation = item.bullet && index > 0 ? 0.25 : 0;
          slide.addText(text, {
            ...base, x: 0.5 + continuation, w: SLIDE_WIDTH - continuation,
            y: item.y + index * item.fontSize * 1.3 / 72, h: item.fontSize * 1.3 / 72 + 0.06,
            fontSize: item.fontSize, lineSpacingMultiple: 1.3,
            ...(item.code ? { fill: { color: "F3F4F6" } } : {}),
            ...(item.bullet && index === 0 ? { bullet: item.bullet } : {}),
          });
        });
      }
    }
  }
  const result = await pptx.write({ outputType: "blob", compression: true });
  if (!(result instanceof Blob)) throw new FileExportError("PPTX export did not produce a file.");
  return result.slice(0, result.size, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
}

async function createXlsx(data: ExportData): Promise<Blob> {
  const sheets = contentSheets(data).map((sheet) => {
    const rows: SheetData = sheet.rows.map((row) => row.map((cell): CellObject => {
      if (typeof cell === "number") return { type: Number, value: cell };
      if (typeof cell === "boolean") return { type: Boolean, value: cell };
      // v4.1.1 indexes shared strings in an ordinary object, so inherited keys corrupt cells.
      if (typeof cell === "string" && Object.hasOwn(Object.prototype, cell)) {
        throw new FileExportError("XLSX contains unsupported cell text. Change the text before exporting.");
      }
      return { type: String, value: safeCell(cell) ?? "" };
    }));
    return { sheet: sheet.name, data: rows };
  });
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const blob = await writeXlsxFile(sheets).toBlob();
  if (!(blob instanceof Blob)) throw new FileExportError("XLSX export did not produce a file.");
  return blob.slice(0, blob.size, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

export async function createOfficeBlob(format: "pptx" | "xlsx", data: ExportData, secrets: readonly string[] = []): Promise<Blob> {
  try {
    checkData(data, secrets);
    if (format === "pptx") return checkArtifact(await createPptx(data));
    if (format === "xlsx") return checkArtifact(await createXlsx(data));
    throw new FileExportError("Unsupported Office export format.");
  } catch (error) {
    if (error instanceof FileExportError) throw error;
    throw new FileExportError("Office export could not be created. Reduce the content and try again.");
  }
}
