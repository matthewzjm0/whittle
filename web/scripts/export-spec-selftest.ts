import assert from "node:assert/strict";
import { createOutputArtifact } from "../components/pipeline/file-export/artifact";
import { validateExportFilename } from "../components/pipeline/file-export/filenames";
import { EXPORT_LIMITS, FileExportError, OUTPUT_FORMATS } from "../components/pipeline/file-export/model";
import type { CellValue, OutputFormat } from "../components/pipeline/file-export/model";
import { checkSecrets } from "../components/pipeline/file-export/safety";
import { parseExportSpec, specData, specStrings } from "../components/pipeline/file-export/spec";
import type { ExportSpec, FilesExportSpec, SingleExportSpec } from "../components/pipeline/file-export/spec";
import { readOfficeTestZip } from "./export-test-zip";

function documentSpec(text = "Structured paragraph"): Extract<SingleExportSpec, { kind: "document" }> {
  return { exportVersion: 1, kind: "document", blocks: [{ type: "paragraph", text }] };
}

function fixtures(): SingleExportSpec[] {
  const rows: CellValue[][] = [["Structured cell", 12, true, null], ["caf\u00e9 \u4e2d\u6587 \ud83d\ude80", -2.5, false, "=1+1"]];
  return [
    { exportVersion: 1, kind: "document", title: "Document fixture", blocks: [
      { type: "heading", level: 1, text: "Overview" },
      { type: "paragraph", text: "Structured paragraph" },
      { type: "list", ordered: false, items: ["First", "Second"] },
      { type: "list", ordered: true, items: ["Ordered"] },
      { type: "code", text: "const answer = 42;", language: "js" },
      { type: "heading", level: 6, text: "Details" },
      { type: "table", rows },
    ] },
    { exportVersion: 1, kind: "slides", title: "Slides fixture", slides: [
      { title: "Opening", blocks: [{ type: "paragraph", text: "Structured paragraph" }, { type: "list", ordered: true, items: ["First", "Second"] }] },
      { title: "Values", blocks: [{ type: "code", text: "const answer = 42;" }, { type: "table", rows }] },
    ] },
    { exportVersion: 1, kind: "sheets", title: "Sheets fixture", sheets: [{ name: "Values", rows }] },
  ];
}

// Wrap only between JSON tokens, so large matrix fixtures exercise structural limits, not line length.
function jsonSource(value: unknown): string {
  const text = JSON.stringify(value);
  assert.ok(text !== undefined, "Fixture must be JSON serializable.");
  const chunks: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (/[,}\]]/.test(char) && i - start >= 1024) {
      chunks.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  chunks.push(text.slice(start));
  return chunks.join("\n");
}

function parsed(value: unknown): ExportSpec {
  const spec = parseExportSpec(jsonSource(value));
  assert.ok(spec, "A recognized valid specification must not fall back to markdown.");
  return spec;
}

function closedError(error: unknown, message: RegExp): boolean {
  assert.ok(error instanceof FileExportError, "Invalid specifications must fail with FileExportError.");
  assert.match(error.message, message);
  assert.ok(error.message.length < 240, "Errors must be bounded and must not echo input.");
  return true;
}

function rejectsSpec(value: unknown, message = /export|JSON|sheet|slide/i): void {
  assert.throws(() => parseExportSpec(typeof value === "string" ? value : jsonSource(value)), (error: unknown) => closedError(error, message));
}

function manifest(): FilesExportSpec {
  return { exportVersion: 1, kind: "files", title: "Manifest fixture", files: OUTPUT_FORMATS.map((format, index) => ({
    name: `part-${index + 1}.${format}`, format, content: documentSpec(),
  })) };
}

export function registerExportSpecTests(test: (name: string, run: () => void | Promise<void>) => void): void {
  const offline = (name: string, run: () => void | Promise<void>) => test(name, async () => {
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("Structured exports must not use the network."); };
    try { await run(); assert.equal(networkCalls, 0); }
    finally { globalThis.fetch = originalFetch; }
  });

  test("strict specs preserve every document block, primitive cell type, and explicit slide/sheet structure", () => {
    for (const fixture of fixtures()) assert.deepEqual(parsed(fixture), fixture);
    assert.deepEqual(parsed(manifest()), manifest());
    assert.equal(parsed({ exportVersion: 1, kind: "slides", slides: [{ title: "Title only", blocks: [] }] }).kind, "slides");
    assert.equal(parsed({ ...documentSpec(), title: "", blocks: [{ type: "code", text: "", language: "" }] }).kind, "document");
  });

  test("spec detection accepts only exact JSON or a whole JSON fence and decodes reserved root keys", () => {
    const fixture = documentSpec();
    const source = jsonSource(fixture);
    assert.deepEqual(parseExportSpec(` \n\t${source}\r\n`), fixture);
    assert.deepEqual(parseExportSpec(`\`\`\`json\n${source}\n\`\`\``), fixture);
    assert.deepEqual(parseExportSpec(`\`\`\`JSON\r\n${source}\r\n\`\`\``), fixture);
    assert.deepEqual(parseExportSpec(source.replace('"exportVersion"', '"\\u0065xportVersion"').replace('"kind"', '"\\u006bind"')), fixture);
    for (const ordinary of ["# Markdown\n\nText", "{}", "[]", "null", "true", "42", '"plain"', '{"ordinary":{"kind":"document"}}',
      `Before\n${source}\nAfter`, `# Example\n\n\`\`\`json\n${source}\n\`\`\``, `\`\`\`js\n${source}\n\`\`\``, "```json\n{\"ordinary\":true}\n```",
    ]) assert.equal(parseExportSpec(ordinary), undefined);
    rejectsSpec(`${source}\ntrailing text`, /Invalid JSON/);
    rejectsSpec('{"exportVersion"', /Invalid JSON/);
    rejectsSpec('{"\\u006bind"', /Invalid JSON/);
    rejectsSpec('{"ordinary":nope,"\\u006bind":"document"}', /Invalid JSON/);
    rejectsSpec('{exportVersion:1,kind:"document",blocks:[]}', /Invalid JSON/);
    rejectsSpec('{"exportVersion":1,"kind":"document","blocks":[],}', /Invalid JSON/);
    rejectsSpec('{"exportVersion":1,/* no JSON5 */"kind":"document","blocks":[]}', /Invalid JSON/);
  });

  test("reserved roots reject unknown versions, unknown kinds, missing fields, and wrong types without fallback", () => {
    for (const invalid of [
      { kind: "document", blocks: [] }, { exportVersion: 1 }, { exportVersion: 2, kind: "document", blocks: [] },
      { ...documentSpec(), exportVersion: "1" }, { ...documentSpec(), kind: "unknown" },
      { exportVersion: 1, kind: "document" }, { ...documentSpec(), blocks: null }, { ...documentSpec(), blocks: [] },
      { ...documentSpec(), title: 7 }, { exportVersion: 1, kind: "slides", slides: [] }, { exportVersion: 1, kind: "sheets", sheets: [] },
      { exportVersion: 1, kind: "files", files: [] }, { exportVersion: 1, kind: "files" },
    ]) rejectsSpec(invalid);
  });

  test("all schema levels reject unknown fields and action/style/formula objects rather than forwarding options", () => {
    for (const invalid of [
      { ...documentSpec(), style: {} }, { ...documentSpec(), slides: [] },
      { ...documentSpec(), blocks: [{ type: "paragraph", text: "Body", hyperlink: "https://example.invalid" }] },
      { ...documentSpec(), blocks: [{ type: "code", text: "Body", ordered: false }] },
      { ...documentSpec(), blocks: [{ type: "table", rows: [[{ formula: "1+1" }]] }] },
      { ...documentSpec(), blocks: [{ type: "paragraph", text: { rawHTML: "<script>" } }] },
      { ...documentSpec(), blocks: [{ type: "rawHTML", text: "<script>" }] },
      { exportVersion: 1, kind: "slides", slides: [{ title: "S", blocks: [], background: "red" }] },
      { exportVersion: 1, kind: "sheets", sheets: [{ name: "S", rows: [[0]], url: "https://example.invalid" }] },
      { ...manifest(), raw: true }, { ...manifest(), files: [{ ...manifest().files[0], options: {} }] },
      { ...manifest(), files: [{ ...manifest().files[0], content: { ...documentSpec(), layout: {} } }] },
    ]) rejectsSpec(invalid);
  });

  test("block validation enforces integer headings, required fields, boolean lists, string items, and no slide body headings", () => {
    for (const block of [
      { type: "heading", level: 0, text: "H" }, { type: "heading", level: 7, text: "H" }, { type: "heading", level: 1.5, text: "H" },
      { type: "heading", level: "1", text: "H" }, { type: "heading", level: 1, text: "x".repeat(121) },
      { type: "paragraph" }, { type: "paragraph", text: null }, { type: "code", text: "x", language: false },
      { type: "list", ordered: "false", items: ["x"] }, { type: "list", ordered: true, items: [1] },
      { type: "list", ordered: true, items: [] }, { type: "table", rows: [] }, null, "paragraph",
    ]) rejectsSpec({ ...documentSpec(), blocks: [block] });
    rejectsSpec({ exportVersion: 1, kind: "slides", slides: [{ title: "S", blocks: [{ type: "heading", level: 2, text: "H" }] }] }, /headings/);
    rejectsSpec({ exportVersion: 1, kind: "slides", slides: [{ blocks: [] }] });
    rejectsSpec({ exportVersion: 1, kind: "slides", slides: [{ title: " ", blocks: [] }] }, /title/);
  });

  test("duplicate decoded JSON keys, including escaped keys in ordinary JSON and nested specs, are rejected", () => {
    for (const source of [
      '{"a":1,"a":2}', '{"a":1,"\\u0061":2}',
      '{"exportVersion":1,"\\u0065xportVersion":1,"kind":"document","blocks":[]}',
      '{"exportVersion":1,"kind":"document","\\u006bind":"document","blocks":[]}',
      '{"exportVersion":1,"kind":"document","blocks":[{"type":"paragraph","text":"a","\\u0074ext":"b"}]}',
      '{"ordinary":[{"nested":1,"nested":2}]}',
    ]) rejectsSpec(source, /duplicate/);
    assert.equal(parseExportSpec('{"a":{"same":1},"b":{"same":2}}'), undefined);
  });

  test("forbidden prototype keys at any depth never pollute Object.prototype, while their text values stay inert", () => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    for (const key of ["__proto__", "prototype", "constructor", "__pro\\u0074o__", "constr\\u0075ctor"]) {
      rejectsSpec(`{"${key}":{"__specPollutionFixture":true}}`, /forbidden/);
      rejectsSpec(`{"ordinary":[{"${key}":0}]}`, /forbidden/);
      rejectsSpec(`{"exportVersion":1,"kind":"document","blocks":[{"type":"paragraph","text":"x","${key}":{}}]}`, /forbidden/);
    }
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
    assert.equal(Object.hasOwn(Object.prototype, "__specPollutionFixture"), false);
    assert.equal(parsed(documentSpec("__proto__ prototype constructor")).kind, "document");
  });

  test("JSON lexical bounds reject nonfinite numbers, excessive depth/nodes/arrays, even for non-spec JSON", () => {
    for (const token of ["1e400", "-1e400"]) {
      rejectsSpec(token, /finite/);
      rejectsSpec(`{"ordinary":${token}}`, /finite/);
      rejectsSpec(`{"exportVersion":1,"kind":"document","blocks":[{"type":"table","rows":[[${token}]]}]}`, /finite/);
    }
    assert.equal(parseExportSpec("[".repeat(12) + "0" + "]".repeat(12)), undefined);
    rejectsSpec("[".repeat(13) + "0" + "]".repeat(13), /depth/);
    rejectsSpec({ ordinary: Array(10001).fill(0) }, /10000-item/);
    rejectsSpec(Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [String(index), 0])), /20000-node/);
  });

  test("decoded controls and unpaired Unicode are rejected in keys and content without echoing them", () => {
    for (const escaped of ["\\u0000", "\\u000b", "\\u001f", "\\u007f", "\\u0085", "\\uFFFE", "\\uFFFF", "\\ud800", "\\udfff", "\\ud800x", "\\ud83d\\ude80\\udfff"]) {
      rejectsSpec(`{"ordinary":"${escaped}"}`, /control|Unicode/);
      rejectsSpec(`{"${escaped}":1}`, /control|Unicode/);
      rejectsSpec(`{"exportVersion":1,"kind":"document","blocks":[{"type":"paragraph","text":"${escaped}"}]}`, /control|Unicode/);
    }
    rejectsSpec(documentSpec("\ud800"), /Unicode/);
    rejectsSpec(documentSpec("\uFFFE"), /Unicode/);
    rejectsSpec(documentSpec("\uFFFF"), /Unicode/);
    rejectsSpec(documentSpec("\n".repeat(2048)), /Decoded.*2048/);
    assert.equal(parsed(documentSpec("Tabs\tand\nlines\r\n\ud83d\ude80")).kind, "document");
    assert.equal(parsed(documentSpec('Literal "keys": {"constructor":1}, commas, [brackets], and \\ paths')).kind, "document");
  });

  test("rectangular matrices preserve primitive types and reject ragged, object, array, and oversized cells", () => {
    const sheet = (rows: unknown) => ({ exportVersion: 1, kind: "sheets", sheets: [{ name: "Values", rows }] });
    for (const rows of [[], [[]], [[0], [0, 1]], [[{}]], [[[]]], [[{ f: "1+1", v: 2 }]], [["x".repeat(2049)]],
      Array.from({ length: 1001 }, () => [0]), [Array(33).fill(0)],
    ]) rejectsSpec(sheet(rows));
    const atLimit = parsed(sheet(Array.from({ length: 1000 }, () => Array(10).fill(0))));
    assert.equal(atLimit.kind, "sheets");
    assert.equal(parsed(sheet([["x".repeat(2048), -42, true, false, null]])).kind, "sheets");
  });

  test("sheet names are bounded and unique under case folding and NFC, with spreadsheet-reserved characters rejected", () => {
    const sheet = (name: string) => ({ name, rows: [[0]] });
    for (const name of ["", " ", "x".repeat(32), "Bad/Name", "Bad\\Name", "Bad:Name", "Bad?Name", "Bad*Name", "Bad[Name]", "'Name", "Name'", "Bad\tName"]) {
      rejectsSpec({ exportVersion: 1, kind: "sheets", sheets: [sheet(name)] });
    }
    for (const names of [["Values", "VALUES"], ["caf\u00e9", "cafe\u0301"]]) {
      rejectsSpec({ exportVersion: 1, kind: "sheets", sheets: names.map(sheet) }, /unique/);
    }
    assert.equal(parsed({ exportVersion: 1, kind: "sheets", sheets: [sheet("x".repeat(31))] }).kind, "sheets");
  });

  test("structural budgets include the entire manifest rather than resetting per file", () => {
    const entry = (content: SingleExportSpec, index: number) => ({ name: `part-${index}.txt`, format: "txt" as const, content });
    const doc = (count: number): SingleExportSpec => ({ ...documentSpec(), blocks: Array.from({ length: count }, () => ({ type: "paragraph", text: "x" })) });
    const sheet = (count: number): SingleExportSpec => ({ exportVersion: 1, kind: "sheets", sheets: [{ name: "Values", rows: Array.from({ length: count }, () => Array(10).fill(0)) }] });
    assert.equal(parsed(doc(256)).kind, "document");
    rejectsSpec(doc(257));
    assert.equal(parsed({ exportVersion: 1, kind: "files", files: [entry(doc(128), 1), entry(doc(128), 2)] }).kind, "files");
    rejectsSpec({ exportVersion: 1, kind: "files", files: [entry(doc(128), 1), entry(doc(129), 2)] }, /256/);
    assert.equal(parsed({ exportVersion: 1, kind: "files", files: [entry(sheet(500), 1), entry(sheet(500), 2)] }).kind, "files");
    rejectsSpec({ exportVersion: 1, kind: "files", files: [entry(sheet(501), 1), entry(sheet(500), 2)] }, /10000 cells/);
    const slides: SingleExportSpec = { exportVersion: 1, kind: "slides", slides: Array.from({ length: 17 }, (_, index) => ({ title: `Slide ${index}`, blocks: [] })) };
    rejectsSpec({ exportVersion: 1, kind: "files", files: [entry(slides, 1), entry(slides, 2)] }, /32 slides/);
    const tables: SingleExportSpec = { ...documentSpec(), blocks: Array.from({ length: 5 }, () => ({ type: "table", rows: [[0]] })) };
    rejectsSpec({ exportVersion: 1, kind: "files", files: [entry(tables, 1), entry(tables, 2)] }, /8 sheets\/tables/);
    assert.equal(parsed({ exportVersion: 1, kind: "files", files: Array.from({ length: 16 }, (_, index) => entry(documentSpec(), index)) }).kind, "files");
    rejectsSpec({ exportVersion: 1, kind: "files", files: Array.from({ length: 17 }, (_, index) => entry(documentSpec(), index)) });
    rejectsSpec({ exportVersion: 1, kind: "slides", slides: [{ title: "S", blocks: [{ type: "paragraph", text: "x".repeat(2501) }] }] }, /2500/);
    rejectsSpec({ ...documentSpec(), title: "x".repeat(121) });
    rejectsSpec({ ...documentSpec(), blocks: [{ type: "code", text: "x", language: "x".repeat(121) }] });
    rejectsSpec({ ...documentSpec(), blocks: [{ type: "list", ordered: false, items: Array(2049).fill("") }] });
    rejectsSpec("x".repeat(EXPORT_LIMITS.sourceChars + 1), /131072/);
  });

  test("filenames accept bounded flat ASCII names for every current format and preserve safe casing", () => {
    for (const format of OUTPUT_FORMATS) {
      const name = `Report Final_2026-10.${format.toUpperCase()}`;
      assert.equal(validateExportFilename(name, format), name);
    }
    assert.equal(validateExportFilename("a".repeat(76) + ".txt", "txt").length, 80);
    for (const stem of ["COM0", "COM10", "LPT0", "LPT10", "CON-report", "report.v1"]) assert.equal(validateExportFilename(`${stem}.txt`, "txt"), `${stem}.txt`);
  });

  test("filename validation immediately rejects hostile paths, encodings, device names, extensions, and controls", () => {
    const hostile = ["", ".hidden.txt", "../part.txt", "folder/part.txt", "folder\\part.txt", "/root.txt", "\\\\host\\part.txt", "C:part.txt", "C:\\part.txt",
      "part%2etxt", "%2e%2e%2fpart.txt", "part..txt", "part.txt.", "part.txt ", "part .txt", "part. txt", "part.txt\n", "part\t.txt", "part\x00.txt",
      "part:stream.txt", "part?.txt", "part*.txt", "part|.txt", "part<.txt", 'part".txt', "-part.txt", "_part.txt", "caf\u00e9.txt", "part\u202e.txt", "part\ud800.txt",
      "part.pdf", "parttxt", "a".repeat(77) + ".txt",
    ];
    for (const stem of ["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)]) {
      hostile.push(`${stem}.txt`, `${stem.toLowerCase()}.extra.txt`);
    }
    for (const name of hostile) assert.throws(() => validateExportFilename(name, "txt"), (error: unknown) => closedError(error, /filename/));
    assert.throws(() => validateExportFilename("part.zip", "zip" as OutputFormat), (error: unknown) => closedError(error, /filename/));
    assert.throws(() => validateExportFilename("private-user-fixture/part.txt", "txt"), (error: unknown) => {
      closedError(error, /filename/);
      assert.ok(error instanceof FileExportError && !error.message.includes("private-user-fixture"));
      return true;
    });
  });

  test("files specs reject unsafe/case-duplicate filenames, unknown formats, nested manifests, and raw ZIP payloads", () => {
    const file = { name: "part.txt", format: "txt", content: documentSpec() };
    for (const files of [
      [{ ...file, name: "../part.txt" }], [{ ...file, name: "CON.txt" }], [{ ...file, name: "part.pdf" }],
      [file, { ...file, name: "PART.TXT" }], [{ ...file, format: "exe" }], [{ ...file, format: "TXT" }],
      [{ ...file, name: "part.zip", format: "zip" }], [{ ...file, content: manifest() }], [{ ...file, content: "UEsDBAoAAAA=" }],
      [{ ...file, data: "UEsDBAoAAAA=" }], [{ ...file, name: "https://example.invalid/file.txt" }],
    ]) rejectsSpec({ exportVersion: 1, kind: "files", files });
  });

  test("specData makes declarative copies and flattens explicit slides/sheets without losing their native structure", () => {
    for (const fixture of fixtures()) {
      const snapshot = structuredClone(fixture);
      const data = specData(fixture, "Fallback");
      assert.equal(data.title, fixture.title);
      if (fixture.kind === "document") assert.deepEqual(data.blocks, fixture.blocks);
      else if (fixture.kind === "slides") {
        assert.deepEqual(data.slides, fixture.slides);
        assert.deepEqual(data.blocks.filter((block) => block.type === "heading").map((block) => block.text), ["Opening", "Values"]);
      } else {
        assert.deepEqual(data.sheets, fixture.sheets);
        assert.deepEqual(data.blocks.map((block) => block.type), ["heading", "table"]);
      }
      const matrix = data.blocks.find((block) => block.type === "table");
      if (matrix?.type === "table") matrix.rows[0][0] = "Changed copy";
      if (data.slides) data.slides[0].title = "Changed copy";
      if (data.sheets) data.sheets[0].rows[0][0] = "Changed copy";
      assert.deepEqual(fixture, snapshot);
    }
    assert.equal(specData(documentSpec(), "Fallback").title, "Fallback");
    assert.throws(() => specData(documentSpec(), "x".repeat(121)), (error: unknown) => closedError(error, /character limit/));
  });

  test("specStrings covers titles, filenames, code languages, list items, slide titles, sheet names, and every cell", () => {
    const spec: FilesExportSpec = { exportVersion: 1, kind: "files", title: "Bundle title", files: [
      { name: "document.txt", format: "txt", content: { ...documentSpec(), title: "Document title", blocks: [
        { type: "heading", level: 2, text: "Heading" }, { type: "paragraph", text: "Paragraph" }, { type: "list", ordered: false, items: ["Item"] },
        { type: "code", text: "Code body", language: "Language" }, { type: "table", rows: [["Cell", 42, true, null]] },
      ] } },
      { name: "slides.pptx", format: "pptx", content: { exportVersion: 1, kind: "slides", title: "Deck title", slides: [{ title: "Slide title", blocks: [{ type: "paragraph", text: "Slide body" }] }] } },
      { name: "sheets.xlsx", format: "xlsx", content: { exportVersion: 1, kind: "sheets", title: "Workbook title", sheets: [{ name: "Sheet name", rows: [["Sheet cell", false]] }] } },
    ] };
    const strings = specStrings(parsed(spec));
    for (const expected of ["Bundle title", "document.txt", "Document title", "Heading", "Paragraph", "Item", "Code body", "Language", "Cell", "42", "true", "",
      "slides.pptx", "Deck title", "Slide title", "Slide body", "sheets.xlsx", "Workbook title", "Sheet name", "Sheet cell", "false",
    ]) assert.ok(strings.includes(expected), "A semantic string was omitted from credential inspection.");
    const known = "configured-fixture-private-2042";
    const fragmented = { ...documentSpec(), blocks: [{ type: "list", ordered: false, items: [known.slice(0, 12), known.slice(12)] }] };
    assert.throws(() => checkSecrets(specStrings(parsed(fragmented)), [known]), (error: unknown) => closedError(error, /credentials/));
  });

  offline("structured document, slide, and sheet inputs generate every applicable format offline and preserve JSON kind", async () => {
    for (const fixture of fixtures()) for (const format of OUTPUT_FORMATS) {
      const { blob, filename } = await createOutputArtifact(jsonSource(fixture), format, "Fallback");
      assert.ok(blob.size > 0 && blob.size <= EXPORT_LIMITS.artifactBytes);
      assert.match(filename, new RegExp(`\\.${format}$`, "i"));
      if (format === "json") assert.deepEqual(JSON.parse(await blob.text()), fixture);
      if (["txt", "md", "html", "svg", "csv"].includes(format)) assert.ok((await blob.text()).includes("Structured cell"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (["docx", "pptx", "xlsx"].includes(format)) assert.deepEqual([...bytes.slice(0, 2)], [80, 75]);
      if (format === "pdf") assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
    }
  });

  offline("structured native PPTX/XLSX preserve explicit titles, sheet names, primitive types, and inert formula strings", async () => {
    const [, slides, sheets] = fixtures();
    const pptx = await readOfficeTestZip((await createOutputArtifact(jsonSource(slides), "pptx")).blob);
    assert.equal([...pptx.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 2);
    assert.match(pptx.get("ppt/slides/slide1.xml")!, /Opening/);
    assert.match(pptx.get("ppt/slides/slide2.xml")!, /Values/);
    const xlsx = await readOfficeTestZip((await createOutputArtifact(jsonSource(sheets), "xlsx")).blob);
    assert.match(xlsx.get("xl/workbook.xml")!, /name="Values"/);
    const worksheet = xlsx.get("xl/worksheets/sheet1.xml")!;
    assert.match(worksheet, /<c\b[^>]*r="B1"[^>]*>[\s\S]*?<v>12<\/v>/);
    assert.match(worksheet, /<c\b(?=[^>]*\br="C1")(?=[^>]*\bt="b")[^>]*>[\s\S]*?<v>1<\/v>/);
    assert.doesNotMatch(worksheet, /<f(?:\s|>|\/)/);
    assert.ok([...xlsx.values()].some((xml) => /(?:&apos;|&#39;|')=1\+1/.test(xml)));
  });

  offline("files specs export a JSON manifest or ZIP and require ZIP for other formats", async () => {
    const fixture = manifest();
    const source = jsonSource(fixture);
    assert.deepEqual(JSON.parse(await (await createOutputArtifact(source, "json")).blob.text()), fixture);
    for (const format of OUTPUT_FORMATS.filter((value) => value !== "json")) {
      await assert.rejects(() => createOutputArtifact(source, format), (error: unknown) => closedError(error, /ZIP.*required|required.*ZIP/i));
    }
    const zipped = await createOutputArtifact(source, "zip");
    assert.equal(zipped.filename, "pipeline-output.zip");
    assert.deepEqual([...new Uint8Array(await zipped.blob.arrayBuffer()).slice(0, 2)], [80, 75]);
  });

  offline("recognized invalid specs and dangerous ordinary JSON fail at the artifact boundary rather than markdown fallback", async () => {
    for (const source of ['{"kind":"document"}', '{"exportVersion":9,"kind":"document","blocks":[]}', '{"ordinary":{"__proto__":{}}}', '{"x":1,"x":2}',
      jsonSource({ ...documentSpec(), blocks: [{ type: "table", rows: [[0], [0, 1]] }] }),
      jsonSource({ exportVersion: 1, kind: "files", files: [{ name: "../part.txt", format: "txt", content: documentSpec() }] }),
    ]) await assert.rejects(() => createOutputArtifact(source, "json"), (error: unknown) => closedError(error, /export|JSON/i));
  });

  offline("safe ordinary JSON and markdown remain ordinary content at the artifact boundary", async () => {
    for (const source of ['{"ordinary":42}', '{"ordinary":{"kind":"document"}}', "Plain markdown paragraph"]) {
      assert.equal(await (await createOutputArtifact(source, "txt")).blob.text(), source);
    }
  });

  offline("configured synthetic secrets, Unicode-escaped strings, and semantic fragments are blocked generically before writers", async () => {
    const known = "configured-fixture-private-2042";
    const unicode = [...known].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const escaped = jsonSource(documentSpec(known)).replace(JSON.stringify(known), `"${unicode}"`);
    const fragmented = jsonSource({ ...documentSpec(), blocks: [{ type: "list", ordered: false, items: [known.slice(0, 12), known.slice(12)] }] });
    const language = jsonSource({ ...documentSpec(), blocks: [{ type: "code", language: known.slice(0, 12), text: known.slice(12) }] });
    const slide = jsonSource({ exportVersion: 1, kind: "slides", slides: [{ title: known.slice(0, 12), blocks: [{ type: "paragraph", text: known.slice(12) }] }] });
    const sheet = jsonSource({ exportVersion: 1, kind: "sheets", sheets: [{ name: known.slice(0, 12), rows: [[known.slice(12)]] }] });
    const invalid = jsonSource({ ...documentSpec(), unknown: known });
    for (const format of OUTPUT_FORMATS) for (const source of [escaped, fragmented, language, slide, sheet, invalid]) {
      await assert.rejects(() => createOutputArtifact(source, format, "Guard", [known]), (error: unknown) => {
        closedError(error, /credentials/);
        assert.ok(error instanceof FileExportError && !error.message.includes(known) && !error.message.includes(unicode));
        return true;
      });
    }
    const filenameKey = "private-fixture.txtcontent-fragment";
    const files = jsonSource({ exportVersion: 1, kind: "files", files: [{ name: "private-fixture.txt", format: "txt", content: documentSpec("content-fragment") }] });
    await assert.rejects(() => createOutputArtifact(files, "json", "Guard", [filenameKey]), (error: unknown) => closedError(error, /credentials/));
    await assert.rejects(() => createOutputArtifact(jsonSource(documentSpec()), "json", known, [known]), /credentials/);
    const layoutOverflow = jsonSource({ exportVersion: 1, kind: "slides", slides: [{ title: "Guard", blocks: [
      { type: "list", ordered: false, items: [known.slice(0, 12), known.slice(12), ...Array(30).fill("item")] },
    ] }] });
    await assert.rejects(() => createOutputArtifact(layoutOverflow, "pptx", "Guard", [known]), (error: unknown) => closedError(error, /credentials/));
  });

  offline("structured hostile markup and executable-looking code remain escaped text with no active resources", async () => {
    const hostile = '<script>globalThis.__specFixtureExecuted=true</script><img src="https://example.invalid" onerror="alert(1)"><foreignObject>payload</foreignObject>';
    const source = jsonSource({ ...documentSpec(), blocks: [{ type: "paragraph", text: hostile }, { type: "code", text: "globalThis.__specFixtureExecuted=true", language: "js" }] });
    assert.equal(Object.hasOwn(globalThis, "__specFixtureExecuted"), false);
    for (const format of ["html", "svg"] as const) {
      const text = await (await createOutputArtifact(source, format)).blob.text();
      assert.doesNotMatch(text, /<(?:script|img|foreignObject|iframe|image|a)\b/i);
      assert.ok(text.includes("&lt;script"));
    }
    assert.equal(Object.hasOwn(globalThis, "__specFixtureExecuted"), false);
  });
}
