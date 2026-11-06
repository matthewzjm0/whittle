import assert from "node:assert/strict";
import { createOutputArtifact } from "../components/pipeline/file-export/artifact";
import { EXPORT_LIMITS, FileExportError } from "../components/pipeline/file-export/model";
import type { CellValue } from "../components/pipeline/file-export/model";
import { createOfficeBlob } from "../components/pipeline/file-export/office";
import { checkArtifact } from "../components/pipeline/file-export/safety";
import { readOfficeTestZip } from "./export-test-zip";

function decodeXml(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (entity, code: string) => {
    if (code[0] === "#") return String.fromCodePoint(parseInt(code.slice(code[1] === "x" ? 2 : 1), code[1] === "x" ? 16 : 10));
    return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[code] ?? entity;
  });
}

function xmlTexts(xml: string, tag = "t"): string {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g"))]
    .map((match) => decodeXml(match[1])).join("");
}

function spreadsheetCell(zip: Map<string, string>, ref: string, sheet = 1): { type: string; value: string } {
  const xml = zip.get(`xl/worksheets/sheet${sheet}.xml`) ?? "";
  const cell = xml.match(new RegExp(`<c\\b(?=[^>]*\\br="${ref}")[^>]*>[\\s\\S]*?<\\/c>`));
  assert.ok(cell, `Spreadsheet fixture cell ${ref} is missing.`);
  const type = cell[0].match(/\bt="([^"]+)"/)?.[1] ?? "n";
  const value = cell[0].match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
  if (type === "s") {
    const strings = [...(zip.get("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)];
    assert.ok(strings[Number(value)], "Spreadsheet fixture shared string is missing.");
    return { type, value: xmlTexts(strings[Number(value)][1]) };
  }
  return { type, value: type === "inlineStr" ? xmlTexts(cell[0]) : decodeXml(value) };
}

function assertPassiveOffice(zip: Map<string, string>): void {
  const contentTypes = zip.get("[Content_Types].xml");
  assert.ok(contentTypes, "Office content types are missing.");
  assert.doesNotMatch(contentTypes, /macroEnabled|vbaProject|activeX/i);
  for (const [name, xml] of zip) {
    if (!name.endsWith("/")) {
      assert.doesNotMatch(name, /vbaProject|activeX|embeddings|externalLinks|webExtensions/i);
      assert.doesNotMatch(name, /\/media\//i);
    }
    if (name.endsWith(".rels")) {
      assert.doesNotMatch(xml, /\bTargetMode\s*=\s*["']External["']/i);
      assert.doesNotMatch(xml, /\bType\s*=\s*["'][^"']*\/(?:hyperlink|image|oleObject)["']/i);
    }
    if (name.endsWith(".xml")) {
      assert.doesNotMatch(xml, /<(?:a:hlinkClick|a:hlinkMouseOver|a:blip|hyperlinks|script|img)\b/i);
      for (const paragraph of xml.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g)) {
        assert.ok((paragraph[0].match(/<a:pPr\b/g) ?? []).length <= 1, "PPTX paragraphs must not repeat paragraph properties.");
      }
    }
  }
}

async function rejectsExport(run: () => Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof FileExportError, "Export must fail with a closed FileExportError.");
    assert.match(error.message, message);
    assert.ok(error.message.length < 240, "Export errors must not contain source content.");
    return true;
  });
}

function markdownTable(rows: number, columns: number): string {
  const row = `| ${Array(columns).fill("x").join(" | ")} |`;
  return [row, `| ${Array(columns).fill("---").join(" | ")} |`, ...Array(rows - 1).fill(row)].join("\n");
}

export function registerOfficeExportTests(test: (name: string, run: () => void | Promise<void>) => void): void {
  const offline = (name: string, run: () => void | Promise<void>) => test(name, async () => {
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("Office export tests forbid network access."); };
    try { await run(); assert.equal(networkCalls, 0, "Office exports must not fetch resources."); }
    finally { globalThis.fetch = originalFetch; }
  });

  offline("Office PPTX ZIP preserves heading slides, native bullets/numbering, code, tables, and Unicode", async () => {
    const source = [
      "# Overview", "", "Unicode: caf\u00e9 \u4e2d\u6587 \ud83d\ude80", "", "- Bullet one", "- Bullet two", "",
      "1. Ordered one", "2. Ordered two", "", "```js", "const answer = 42;", "console.log(answer);", "```", "",
      "| Name | Count |", "| --- | --- |", "| Alpha | 3 |", "", "## Details", "", "Second slide.",
    ].join("\n");
    const { blob, filename } = await createOutputArtifact(source, "pptx", "Office fixture");
    assert.match(filename, /\.pptx$/);
    assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    const zip = await readOfficeTestZip(blob);
    assertPassiveOffice(zip);
    assert.match(zip.get("[Content_Types].xml")!, /presentationml\.presentation\.main\+xml/);
    assert.equal([...zip.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 2);
    assert.equal((zip.get("ppt/presentation.xml")!.match(/<p:sldId\b/g) ?? []).length, 2);
    const first = zip.get("ppt/slides/slide1.xml")!;
    const text = xmlTexts(first, "a:t");
    for (const expected of ["Overview", "caf\u00e9 \u4e2d\u6587 \ud83d\ude80", "Bullet one", "Ordered two", "const answer = 42;", "console.log(answer);", "Name", "Alpha", "3"]) {
      assert.ok(text.includes(expected), "PPTX fixture text was lost.");
    }
    assert.equal((first.match(/<a:buChar\b/g) ?? []).length, 2);
    assert.equal((first.match(/<a:buAutoNum\b/g) ?? []).length, 2);
    assert.match(first, /<a:buAutoNum\b[^>]*type="arabicPeriod"/);
    assert.match(first, /<a:buAutoNum\b[^>]*startAt="2"/);
    assert.match(first, /<a:tbl\b/);
    assert.match(first, /typeface="Courier New"/);
    assert.ok(xmlTexts(zip.get("ppt/slides/slide2.xml")!, "a:t").includes("DetailsSecond slide."));
  });

  offline("Office PPTX bounded wrapping keeps one native bullet per item and dense text intact", async () => {
    const item = "wrapped item ".repeat(18);
    const bullet = await createOutputArtifact(`# Wrapped\n\n- ${item}`, "pptx");
    const bulletXml = (await readOfficeTestZip(bullet.blob)).get("ppt/slides/slide1.xml")!;
    assert.equal((bulletXml.match(/<a:buChar\b/g) ?? []).length, 1);
    assert.ok((bulletXml.match(/<p:sp\b/g) ?? []).length >= 3, "Wrapped list text needs separate fixed line boxes.");
    assert.ok(xmlTexts(bulletXml, "a:t").includes(item.trimEnd()));
    const dense = "Dense text ".repeat(220);
    const blob = await createOfficeBlob("pptx", { title: "T".repeat(120), blocks: [{ type: "paragraph", text: dense }] });
    const xml = (await readOfficeTestZip(blob)).get("ppt/slides/slide1.xml")!;
    assert.equal(xmlTexts(xml, "a:t"), "T".repeat(120) + dense);
    const wide = await createOutputArtifact(`# Wide\n\n${markdownTable(2, 32)}`, "pptx");
    const wideXml = (await readOfficeTestZip(wide.blob)).get("ppt/slides/slide1.xml")!;
    assert.equal((wideXml.match(/<a:gridCol\b/g) ?? []).length, 32);
  });

  offline("Office XLSX ZIP derives multiple markdown tables and a Content fallback", async () => {
    const { blob, filename } = await createOutputArtifact(`${markdownTable(2, 2)}\n\n${markdownTable(3, 1)}`, "xlsx", "Tables");
    assert.match(filename, /\.xlsx$/);
    assert.equal(blob.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const zip = await readOfficeTestZip(blob);
    assertPassiveOffice(zip);
    assert.match(zip.get("[Content_Types].xml")!, /spreadsheetml\.sheet\.main\+xml/);
    assert.match(zip.get("xl/workbook.xml")!, /name="Table 1"/);
    assert.match(zip.get("xl/workbook.xml")!, /name="Table 2"/);
    assert.equal(spreadsheetCell(zip, "B2").value, "x");
    assert.equal(spreadsheetCell(zip, "A3", 2).value, "x");
    const fallback = await createOutputArtifact("Plain caf\u00e9 \u4e2d\u6587 \ud83d\ude80", "xlsx");
    const fallbackZip = await readOfficeTestZip(fallback.blob);
    assertPassiveOffice(fallbackZip);
    assert.match(fallbackZip.get("xl/workbook.xml")!, /name="Content"/);
    assert.equal(spreadsheetCell(fallbackZip, "A1").value, "Content");
    assert.equal(spreadsheetCell(fallbackZip, "A2").value, "Plain caf\u00e9 \u4e2d\u6587 \ud83d\ude80");
  });

  offline("Office XLSX uses escaped text cells for formula-like strings and preserves typed numbers/booleans", async () => {
    const formulas = ["=1+1", "+SUM(A1:A2)", "-2", "@SUM(A1)", "  =1", "\t=1", "\r+1", "\n@x", "\tplain", "\ufeff-1"];
    const row: CellValue[] = [...formulas, -42, 1.5, true, false, null, "caf\u00e9 \u4e2d\u6587 \ud83d\ude80", "<b>literal & safe</b>"];
    const blob = await createOfficeBlob("xlsx", { title: "Typed cells", blocks: [], sheets: [{ name: "Values", rows: [row] }] });
    const zip = await readOfficeTestZip(blob);
    assertPassiveOffice(zip);
    for (const [name, xml] of zip) if (/^xl\/worksheets\/.*\.xml$/.test(name)) assert.doesNotMatch(xml, /<f(?:\s|>|\/)/);
    formulas.forEach((value, index) => {
      const cell = spreadsheetCell(zip, `${String.fromCharCode(65 + index)}1`);
      assert.ok(cell.type === "s" || cell.type === "inlineStr");
      assert.equal(cell.value, `'${value}`);
    });
    assert.deepEqual(spreadsheetCell(zip, "K1"), { type: "n", value: "-42" });
    assert.deepEqual(spreadsheetCell(zip, "L1"), { type: "n", value: "1.5" });
    assert.deepEqual(spreadsheetCell(zip, "M1"), { type: "b", value: "1" });
    assert.deepEqual(spreadsheetCell(zip, "N1"), { type: "b", value: "0" });
    assert.equal(spreadsheetCell(zip, "P1").value, "caf\u00e9 \u4e2d\u6587 \ud83d\ude80");
    assert.equal(spreadsheetCell(zip, "Q1").value, "<b>literal & safe</b>");
    const markdown = await createOutputArtifact("| Formula |\n| --- |\n| =1+1 |", "xlsx");
    assert.equal(spreadsheetCell(await readOfficeTestZip(markdown.blob), "A2").value, "'=1+1");
  });

  offline("Office hostile HTML, links, and executable-looking code remain passive text", async () => {
    const marker = "__officeExportFixtureExecuted";
    assert.equal(Object.hasOwn(globalThis, marker), false);
    const html = '<img src="https://office-export.invalid/never" onerror="globalThis.__officeExportFixtureExecuted=true">';
    const link = "[link](https://office-export.invalid/never)";
    const source = `# Passive\n\n${html}\n\n${link}\n\n\`\`\`js\nglobalThis.__officeExportFixtureExecuted = true;\n\`\`\``;
    try {
      for (const format of ["pptx", "xlsx"] as const) {
        const { blob } = await createOutputArtifact(source, format);
        const zip = await readOfficeTestZip(blob);
        assertPassiveOffice(zip);
        if (format === "pptx") {
          const text = xmlTexts(zip.get("ppt/slides/slide1.xml")!, "a:t");
          assert.ok(text.includes(html) && text.includes(link));
        } else {
          const strings = [...zip.values()].map((xml) => xmlTexts(xml)).join("");
          assert.ok(strings.includes(html) && strings.includes(link));
        }
        assert.equal(Object.hasOwn(globalThis, marker), false, "Export content must never execute.");
      }
    } finally { Reflect.deleteProperty(globalThis, marker); }
  });

  offline("Office PPTX rejects slide, title, character, line, list, and table layout overflow clearly", async () => {
    await rejectsExport(() => createOutputArtifact(Array.from({ length: 33 }, (_, i) => `# Slide ${i}`).join("\n"), "pptx"), /32|slides|headings/i);
    await rejectsExport(() => createOutputArtifact(`# ${"t".repeat(121)}`, "pptx"), /120|title|heading/i);
    await rejectsExport(() => createOutputArtifact(`# Slide\n\n${"x".repeat(2501)}`, "pptx"), /2500|slide/i);
    await rejectsExport(() => createOutputArtifact(`# ${"\u4e2d".repeat(120)}`, "pptx"), /title layout|heading/i);
    const fixtures = [
      `# Slide\n\n\`\`\`\n${Array(40).fill("line").join("\n")}\n\`\`\``,
      `# Slide\n\n\`\`\`\n${"x".repeat(180)}\n\`\`\``,
      `# Slide\n\n${Array(30).fill("- item").join("\n")}`,
      `# Slide\n\n${markdownTable(2, 32).replace(/^.+/, `| ${Array(32).fill("x".repeat(70)).join(" | ")} |`)}`,
      `# Slide\n\n${markdownTable(30, 2)}`,
    ];
    for (const source of fixtures) await rejectsExport(() => createOutputArtifact(source, "pptx"), /layout|slide space|split/i);
    const maxSlides = await createOutputArtifact(Array.from({ length: 32 }, (_, i) => `# Slide ${i}\n\nText`).join("\n\n"), "pptx");
    assert.equal([...((await readOfficeTestZip(maxSlides.blob)).keys())].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 32);
  });

  offline("Office XLSX rejects row, column, cell, sheet, and cell-text limits without truncation", async () => {
    const fixtures: [string, RegExp][] = [
      [markdownTable(1001, 1), /1000|rows/i],
      [markdownTable(1, 33), /32|columns/i],
      [markdownTable(910, 11), /10000|cells/i],
      [`| Cell |\n| --- |\n| ${"x".repeat(2049)} |`, /2048|cell/i],
      [Array(9).fill(markdownTable(1, 1)).join("\n\n"), /8|sheets|tables/i],
    ];
    for (const [source, message] of fixtures) await rejectsExport(() => createOutputArtifact(source, "xlsx"), message);
    await rejectsExport(() => createOfficeBlob("xlsx", { title: "Invalid", blocks: [], sheets: [{ name: "Bad/Name", rows: [["x"]] }] }), /sheet names/i);
    await rejectsExport(() => createOfficeBlob("xlsx", { title: "Invalid", blocks: [], sheets: [{ name: "Cells", rows: [[Infinity]] }] }), /finite|cells/i);
    for (const text of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      await rejectsExport(() => createOfficeBlob("xlsx", { title: "Writer limitation", blocks: [], sheets: [{ name: "Cells", rows: [[text]] }] }), /unsupported cell text/i);
    }
    const rows = Array.from({ length: 1000 }, () => Array<CellValue>(10).fill("x"));
    const zip = await readOfficeTestZip(await createOfficeBlob("xlsx", { title: "At limits", blocks: [], sheets: [{ name: "Limits", rows }] }));
    assert.equal(spreadsheetCell(zip, "J1000").value, "x");
  });

  offline("Office input and serialized artifact sizes fail with explicit bounded errors", async () => {
    for (const format of ["pptx", "xlsx"] as const) {
      await rejectsExport(() => createOutputArtifact("x".repeat(EXPORT_LIMITS.sourceChars + 1), format), /input|limit|characters/i);
    }
    assert.throws(() => checkArtifact(new Blob([])), (error: unknown) => error instanceof FileExportError && /empty|limit/i.test(error.message));
    const exact = new Blob([new Uint8Array(EXPORT_LIMITS.artifactBytes)]);
    assert.strictEqual(checkArtifact(exact), exact);
    assert.throws(() => checkArtifact(new Blob([new Uint8Array(EXPORT_LIMITS.artifactBytes + 1)])), (error: unknown) => error instanceof FileExportError && /4 MiB|limit/i.test(error.message));
  });

  offline("Office known synthetic secrets are blocked before Office layout/writing with no source in errors", async () => {
    const known = "office-fixture-private-value-42";
    const credential = "sk-" + "syntheticfixturecredential".repeat(2);
    for (const format of ["pptx", "xlsx"] as const) {
      for (const value of [known, credential, encodeURIComponent(known).replace(/o/g, "%6f")]) {
        // The oversized list would fail PPTX layout if a writer were reached first.
        const source = `# Guard\n\n${value}\n\n${Array(30).fill("- item").join("\n")}`;
        await assert.rejects(() => createOutputArtifact(source, format, "Guard", [known]), (error: unknown) => {
          assert.ok(error instanceof FileExportError);
          assert.match(error.message, /blocked|credentials|secrets/i);
          assert.equal(error.message.includes(known) || error.message.includes(credential), false);
          return true;
        });
      }
    }
    await rejectsExport(() => createOfficeBlob("xlsx", { title: "Guard", blocks: [], sheets: [{ name: "Guard", rows: [[known]] }] }, [known]), /credentials/);
    await rejectsExport(() => createOfficeBlob("pptx", { title: "Guard", blocks: [{ type: "paragraph", text: credential }] }), /credentials/);
  });

  offline("Office bounded ZIP fixture reader rejects malformed and oversized archives", async () => {
    await assert.rejects(() => readOfficeTestZip(new Blob([new Uint8Array(22)])), /ZIP local header/);
    await assert.rejects(() => readOfficeTestZip(new Blob([new Uint8Array(EXPORT_LIMITS.artifactBytes + 1)])), /size.*bounds/i);
    const valid = await createOfficeBlob("xlsx", { title: "Fixture", blocks: [], sheets: [{ name: "Fixture", rows: [["x"]] }] });
    const bytes = new Uint8Array(await valid.arrayBuffer());
    await assert.rejects(() => readOfficeTestZip(new Blob([bytes.subarray(0, bytes.length - 10)])), /central directory/);
  });
}
