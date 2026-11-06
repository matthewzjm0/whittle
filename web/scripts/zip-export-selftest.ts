import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { createOutputArtifact } from "../components/pipeline/file-export/artifact";
import { EXPORT_LIMITS, FileExportError } from "../components/pipeline/file-export/model";
import type { OutputFormat } from "../components/pipeline/file-export/model";
import type { FilesExportSpec, SingleExportSpec } from "../components/pipeline/file-export/spec";
import { createZipBundle } from "../components/pipeline/file-export/zip";

function document(text = "Bundle text"): SingleExportSpec {
  return { exportVersion: 1, kind: "document", blocks: [{ type: "paragraph", text }] };
}
function file(name: string, format: OutputFormat, content = document()) {
  return { name, format, content };
}
function manifest(files: ReturnType<typeof file>[]): FilesExportSpec {
  return { exportVersion: 1, kind: "files", files };
}
async function rejects(run: () => Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof FileExportError);
    assert.match(error.message, message);
    assert.ok(error.message.length < 240);
    return true;
  });
}

export function registerZipExportTests(test: (name: string, run: () => void | Promise<void>) => void): void {
  const offline = (name: string, run: () => void | Promise<void>) => test(name, async () => {
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error("ZIP export must not use the network."); };
    try { await run(); assert.equal(networkCalls, 0); }
    finally { globalThis.fetch = originalFetch; }
  });

  offline("ZIP bundles preserve named text, neutralized CSV, and inert escaped HTML", async () => {
    const table: SingleExportSpec = { exportVersion: 1, kind: "document", blocks: [{ type: "table", rows: [["Value"], ["=1+1"]] }] };
    const hostile = document('before<script>globalThis.__zipExportExecuted=true</script>after');
    const source = JSON.stringify(manifest([
      file("report.txt", "txt", document("hello 中文")), file("table.csv", "csv", table), file("page.html", "html", hostile),
    ]));
    const artifact = await createOutputArtifact(source, "zip");
    assert.equal(artifact.filename, "pipeline-output.zip");
    assert.equal(artifact.blob.type, "application/zip");
    const files = unzipSync(new Uint8Array(await artifact.blob.arrayBuffer()));
    assert.deepEqual(Object.keys(files).sort(), ["page.html", "report.txt", "table.csv"]);
    const decoder = new TextDecoder();
    assert.equal(decoder.decode(files["report.txt"]), "hello 中文");
    assert.match(decoder.decode(files["table.csv"]), /"'=1\+1"/);
    const html = decoder.decode(files["page.html"]);
    assert.doesNotMatch(html, /<script\b/i);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(Object.hasOwn(globalThis, "__zipExportExecuted"), false);
  });

  offline("ZIP requires a files specification and rejects hostile or duplicate filenames", async () => {
    await rejects(() => createOutputArtifact("# Markdown", "zip"), /files specification/);
    for (const name of ["../secret.txt", "/absolute.txt", ".hidden.txt", "CON.txt", "folder/file.txt", `${"x".repeat(77)}.txt`, "C:\\file.txt"]) {
      await rejects(() => createOutputArtifact(JSON.stringify(manifest([file(name, "txt")])), "zip"), /filename|character limit/i);
    }
    await rejects(() => createOutputArtifact(JSON.stringify(manifest([file("same.txt", "txt"), file("SAME.TXT", "txt")])), "zip"), /unique/i);
    await rejects(() => createZipBundle([{ name: "../secret.txt", format: "txt", blob: new Blob(["x"]) }]), /filename/);
    await rejects(() => createZipBundle([
      { name: "same.txt", format: "txt", blob: new Blob(["x"]) }, { name: "SAME.TXT", format: "txt", blob: new Blob(["y"]) },
    ]), /unique/);
  });

  offline("ZIP rejects empty, excessive, nested, and per-file oversized bundles clearly", async () => {
    await rejects(() => createOutputArtifact(JSON.stringify(manifest([])), "zip"), /array|16/);
    await rejects(() => createZipBundle([]), /1-16/);
    const tooMany = Array.from({ length: 17 }, (_, index) => file(`part-${index}.txt`, "txt"));
    await rejects(() => createOutputArtifact(JSON.stringify(manifest(tooMany)), "zip"), /array|16/);
    await rejects(() => createZipBundle(tooMany.map((entry) => ({ ...entry, blob: new Blob(["x"]) }))), /1-16/);
    await rejects(() => createOutputArtifact(JSON.stringify(manifest([file("nested.zip", "zip" as OutputFormat)])), "zip"), /format|ZIP/i);
    await rejects(() => createZipBundle([{ name: "huge.txt", format: "txt", blob: new Blob([new Uint8Array(EXPORT_LIMITS.artifactBytes + 1)]) }]), /4 MiB/);
  });

  offline("ZIP enforces the aggregate uncompressed limit and accepts the exact boundary", async () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      name: `large-${index}.txt`, format: "txt" as const, blob: new Blob([new Uint8Array(EXPORT_LIMITS.artifactBytes)]),
    }));
    await rejects(() => createZipBundle(entries), /16 MiB/);
    const exact = entries.slice(0, 4);
    const blob = await createZipBundle(exact);
    assert.equal(blob.type, "application/zip");
    assert.ok(blob.size > 0 && blob.size <= EXPORT_LIMITS.bundleBytes);
  });

  offline("ZIP blocks raw, decoded, and filename credentials before writing", async () => {
    const known = "zip-fixture-private-value-123";
    const unicode = [...known].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const encoded = JSON.stringify(document(known)).replace(JSON.stringify(known), `"${unicode}"`);
    for (const source of [JSON.stringify(manifest([file("report.txt", "txt", document(known))])), JSON.stringify(manifest([file(`${known}.txt`, "txt")])), encoded]) {
      await assert.rejects(() => createOutputArtifact(source, "zip", "Guard", [known]), (error: unknown) => {
        assert.ok(error instanceof FileExportError);
        assert.match(error.message, /credentials/);
        assert.ok(!error.message.includes(known));
        return true;
      });
    }
  });
}
