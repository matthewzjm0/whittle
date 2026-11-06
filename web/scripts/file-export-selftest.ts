import assert from "node:assert/strict";
import { createDataArtifact, createOutputArtifact } from "../components/pipeline/file-export/artifact";
import { contentText, parseExportMarkdown } from "../components/pipeline/file-export/content";
import { EXPORT_LIMITS, FileExportError, OUTPUT_FORMATS } from "../components/pipeline/file-export/model";
import type { OutputFormat } from "../components/pipeline/file-export/model";
import { checkSecrets, safeCell } from "../components/pipeline/file-export/safety";
import { createDocxBlob, createPdfBlob, pdfReplacesCharacters } from "../components/pipeline/export-document";
import { suggestOutputFormat } from "../components/pipeline/format-selection";

export function registerFileExportTests(test: (name: string, run: () => void | Promise<void>) => void) {
  test("every output format creates a bounded offline file without executing source text", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("Exports must not use the network."); };
    const source = "# Report\n\n- First point\n- Second point\n\n| Name | Count |\n| --- | --- |\n| Alpha | 3 |\n\n```js\nglobalThis.__exportExecuted = true;\n```";
    try {
      for (const format of OUTPUT_FORMATS) {
        const { blob, filename } = await createOutputArtifact(source, format);
        assert.ok(blob.size > 0 && blob.size <= EXPORT_LIMITS.artifactBytes);
        assert.equal(filename, `pipeline-output.${format}`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (["pptx", "xlsx", "docx"].includes(format)) assert.deepEqual([...bytes.slice(0, 2)], [80, 75]);
        if (format === "pdf") assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
      }
      assert.equal(Object.hasOwn(globalThis, "__exportExecuted"), false);
    } finally { globalThis.fetch = original; }
  });

  test("markdown export parsing preserves headings, lists, escaped tables, and literal code", () => {
    const data = parseExportMarkdown("## Title\n\n1. One\n2. Two\n\n| A | B |\n| --- | --- |\n| a\\|b | c |\n\n```js\n| not | a table |\n```", "Fixture");
    assert.deepEqual(data.blocks.map((block) => block.type), ["heading", "list", "table", "code"]);
    assert.ok(contentText(data, true).includes("a\\|b"));
    assert.ok(contentText(data).includes("| not | a table |"));
  });

  test("HTML and SVG export hostile markup as escaped inert text with no active resources", async () => {
    const hostile = '</text><script>globalThis.__exportExecuted=true</script><img src="https://example.invalid" onerror="alert(1)"><foreignObject>payload</foreignObject>';
    for (const format of ["html", "svg"] as const) {
      const text = await (await createOutputArtifact(hostile, format)).blob.text();
      assert.doesNotMatch(text, /<(?:script|img|foreignObject|iframe|image|a)\b/i);
      assert.ok(text.includes("&lt;script&gt;") || text.includes("&lt;script"));
      if (format === "html") assert.match(text, /Content-Security-Policy.*default-src 'none'/);
      else assert.ok([...text.matchAll(/<([a-zA-Z]+)/g)].every((tag) => ["svg", "title", "rect", "text", "tspan"].includes(tag[1])));
    }
    assert.equal(Object.hasOwn(globalThis, "__exportExecuted"), false);
  });

  test("CSV formula prefixes are neutralized independently of CSV quoting", async () => {
    const values = ["=1+1", "+SUM(A1:A2)", "-2", "@SUM(A1)", "\t=1", "\r+1", "\n@x", "\tplain", "  =1", "\ufeff-1"];
    for (const value of values) assert.equal(safeCell(value), `'${value}`);
    assert.equal(safeCell(-42), -42);
    assert.equal(safeCell("normal"), "normal");
    const csv = await (await createOutputArtifact('| Value |\n| --- |\n| =1+1 |\n| +1 |\n| -2 |\n| @x |\n| comma,"quote" |', "csv")).blob.text();
    assert.match(csv, /"'=1\+1"/);
    assert.match(csv, /"'\+1"/);
    assert.match(csv, /"'-2"/);
    assert.match(csv, /"'@x"/);
    assert.match(csv, /"comma,""quote"""/);
    await assert.rejects(() => createOutputArtifact("| A |\n| --- |\n| x |\n\n| B |\n| --- |\n| y |", "csv"), /one sheet/);
  });

  test("all exporters block known, encoded, fragmented, and recognizable credentials with generic errors", async () => {
    const known = "configured-fixture-value-0123456789";
    const base64 = btoa(known);
    const sources = [known, base64, base64.slice(0, 8) + "\n\n" + base64.slice(8), encodeURIComponent(base64), known.slice(0, 10) + "\n\n" + known.slice(10), "100% " + [...known].map((char) => `%${char.charCodeAt(0).toString(16)}`).join(""), [...known].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""), "sk-" + "syntheticcredential".repeat(2)];
    for (const format of OUTPUT_FORMATS) for (const source of sources) {
      await assert.rejects(() => createOutputArtifact(source, format, "Fixture", [known]), (error: unknown) => error instanceof FileExportError && /credentials/.test(error.message) && !error.message.includes(known));
    }
    await assert.rejects(() => createOutputArtifact("Content", "txt", known, [known]), /credentials/);
  });

  test("all exporters reject excessive inputs and invalid structural/layout content clearly", async () => {
    for (const format of OUTPUT_FORMATS) await assert.rejects(() => createOutputArtifact("x".repeat(EXPORT_LIMITS.sourceChars + 1), format), /131072/);
    for (const source of ["", "\u0000", "x".repeat(8193), "a\n".repeat(2049), "p\n\n".repeat(257), "```js\nunclosed", "| A | B |\n| --- | --- |\n| x | "]) {
      await assert.rejects(() => createOutputArtifact(source, "txt"), (error: unknown) => error instanceof FileExportError && error.message.length < 240);
    }
    await assert.rejects(() => createOutputArtifact("line\n".repeat(161), "svg"), /160/);
    await assert.rejects(() => createOutputArtifact("Text", "exe" as OutputFormat), /Unsupported/);
  });

  test("Unicode PDF fallback remains explicit when the embedded font option is skipped", async () => {
    const source = "# 中文标题\n\ncafé";
    assert.equal(pdfReplacesCharacters(source), true);
    const { blob } = await createOutputArtifact(source, "pdf");
    assert.equal(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()).slice(0, 5)), "%PDF-");
    assert.ok(blob.size <= EXPORT_LIMITS.artifactBytes);
    assert.equal(pdfReplacesCharacters("Plain ASCII and café"), false);
  });

  test("UTF-8 configured secrets are safe to compare and blocked in encoded form", () => {
    const secret = "密码密钥-fixture-42";
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(secret)));
    assert.doesNotThrow(() => checkSecrets(["safe content"], [secret]));
    assert.throws(() => checkSecrets([secret], [secret]), /credentials/);
    assert.throws(() => checkSecrets([encoded], [secret]), /credentials/);
    assert.throws(() => checkSecrets([encoded.slice(0, 4) + " " + encoded.slice(4)], [secret]), /credentials/);
  });

  test("lower-level exporters enforce source, credential, format, and heading guards", async () => {
    await assert.rejects(() => createPdfBlob("x".repeat(EXPORT_LIMITS.sourceChars + 1)), /131072/);
    await assert.rejects(() => createDocxBlob("sk-" + "syntheticcredential".repeat(2)), /credentials/);
    await assert.rejects(() => createDataArtifact({ title: "T", blocks: [] }, "exe" as OutputFormat), /Unsupported/);
    await assert.rejects(() => createDataArtifact({
      title: "T",
      blocks: [{ type: "heading", level: "1><script>alert(1)</script><h" as unknown as number, text: "X" }],
    }, "html"), /heading levels/);
  });

  test("XML-forbidden noncharacters are rejected for literal and structured exports", async () => {
    for (const char of ["\uFFFE", "\uFFFF"]) {
      await assert.rejects(() => createOutputArtifact(`text${char}`, "svg"), /Unicode/);
      await assert.rejects(() => createOutputArtifact(`{"exportVersion":1,"kind":"document","blocks":[{"type":"paragraph","text":"${char}"}]}`, "svg"), /Unicode/);
    }
  });

  test("automatic export format uses structured kind or markdown layout and defaults prose to DOCX", () => {
    assert.equal(suggestOutputFormat('{"exportVersion":1,"kind":"document","blocks":[{"type":"paragraph","text":"x"}]}'), "docx");
    assert.equal(suggestOutputFormat('{"exportVersion":1,"kind":"slides","slides":[{"title":"Slide","blocks":[]}]}'), "pptx");
    assert.equal(suggestOutputFormat('{"exportVersion":1,"kind":"sheets","sheets":[{"name":"Data","rows":[[1]]}]}'), "xlsx");
    assert.equal(suggestOutputFormat('{"exportVersion":1,"kind":"files","files":[{"name":"a.txt","format":"txt","content":{"exportVersion":1,"kind":"document","blocks":[{"type":"paragraph","text":"x"}]}}]}'), "zip");
    assert.equal(suggestOutputFormat("# One\n\nText\n\n# Two\n\nMore"), "pptx");
    assert.equal(suggestOutputFormat("| A |\n| --- |\n| x |"), "csv");
    assert.equal(suggestOutputFormat("| A |\n| --- |\n| x |\n\n| B |\n| --- |\n| y |"), "xlsx");
    assert.equal(suggestOutputFormat("A plain answer."), "docx");
    assert.throws(() => suggestOutputFormat('{"exportVersion":2,"kind":"document","blocks":[]}'), /export specification/i);
  });
}
