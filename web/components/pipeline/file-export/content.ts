import { EXPORT_LIMITS, FileExportError } from "./model";
import type { ExportBlock, ExportData, ExportSheet, ExportSlide } from "./model";
import { blockStrings, checkSheets } from "./safety";

function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  const text = line.replace(/^ *\|/, "").replace(/\| *$/, "");
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "|") { cell += "|"; i++; }
    else if (text[i] === "|") { cells.push(cell.replace(/^ +| +$/g, "")); cell = ""; }
    else cell += text[i];
  }
  cells.push(cell.replace(/^ +| +$/g, ""));
  return cells;
}

export function parseExportMarkdown(text: string, title: string): ExportData {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ExportBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^\s]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      while (++i < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) code.push(lines[i]);
      if (i === lines.length) throw new FileExportError("Unclosed markdown code fence.");
      blocks.push({ type: "code", text: code.join("\n"), ...(fence[2] ? { language: fence[2] } : {}) });
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, text: heading[2] }); continue; }
    if (i + 1 < lines.length && line.includes("|") && tableCells(lines[i + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const rows = [tableCells(line)]; i++;
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) rows.push(tableCells(lines[++i]));
      blocks.push({ type: "table", rows }); continue;
    }
    const list = line.match(/^\s*(?:([-+*])|(\d{1,6})[.)])\s+(.+)$/);
    if (list) {
      const previous = blocks.at(-1);
      if (previous?.type === "list" && previous.ordered === !!list[2]) previous.items.push(list[3]);
      else blocks.push({ type: "list", ordered: !!list[2], items: [list[3]] });
      continue;
    }
    const previous = blocks.at(-1);
    if (previous?.type === "paragraph" && i > 0 && lines[i - 1].trim()) previous.text += `\n${line}`;
    else blocks.push({ type: "paragraph", text: line });
  }
  return { title, blocks };
}

export function contentText(data: ExportData, markdown = false): string {
  return data.blocks.map((block) => {
    if (block.type === "heading") return `${markdown ? "#".repeat(block.level) + " " : ""}${block.text}`;
    if (block.type === "list") return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${item}`).join("\n");
    if (block.type === "table") {
      const rows = block.rows.map((row) => row.map((cell) => cell === null ? "" : String(cell)));
      if (!markdown) return rows.map((row) => row.join("\t")).join("\n");
      const table = rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ")).join(" | ")} |`);
      table.splice(1, 0, `| ${rows[0].map(() => "---").join(" | ")} |`);
      return table.join("\n");
    }
    if (block.type === "code" && markdown) {
      let length = 3;
      for (const match of block.text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
      const fence = "`".repeat(length);
      return `${fence}${block.language ?? ""}\n${block.text}\n${fence}`;
    }
    return block.text;
  }).join("\n\n");
}

export function contentSheets(data: ExportData): ExportSheet[] {
  const sheets = data.sheets ?? data.blocks.filter((block) => block.type === "table").map((block, index) => ({ name: `Table ${index + 1}`, rows: block.rows }));
  const result = sheets.length ? sheets : [{ name: "Content", rows: [["Content"], ...contentText(data).split("\n").map((line) => [line])] }];
  checkSheets(result);
  return result;
}

export function contentSlides(data: ExportData): ExportSlide[] {
  const slides: ExportSlide[] = data.slides ?? [];
  if (!data.slides) for (const block of data.blocks) {
    if (block.type === "heading") slides.push({ title: block.text, blocks: [] });
    else { if (!slides.length) slides.push({ title: data.title, blocks: [] }); slides.at(-1)!.blocks.push(block); }
  }
  if (!slides.length || slides.length > EXPORT_LIMITS.slides) throw new FileExportError("PPTX requires 1-32 slides. Add or remove markdown headings.");
  for (const slide of slides) if (slide.title.length > EXPORT_LIMITS.titleChars || blockStrings(slide.blocks).join("\n").length > EXPORT_LIMITS.slideChars) throw new FileExportError("A slide exceeds 120 title characters or 2500 body characters. Split it with headings.");
  return slides;
}
