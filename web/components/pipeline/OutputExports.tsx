"use client";

import { useState } from "react";
import { FileExportError, VISIBLE_DOWNLOAD_FORMATS } from "./file-export/model";
import type { DownloadFormat } from "./file-export/model";
import s from "./output-exports.module.css";

export function OutputExports({ text, name, getSecrets }: { text: string; name: string; getSecrets: () => string[] }) {
  const [format, setFormat] = useState<DownloadFormat | "auto">("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [instructions, setInstructions] = useState("");
  async function copyInstructions() {
    setError(""); setNotice("");
    try {
      const { FORMAT_FOR_EXPORT } = await import("./file-export/format-instructions");
      setInstructions(FORMAT_FOR_EXPORT);
      await navigator.clipboard.writeText(FORMAT_FOR_EXPORT);
      setNotice("Export instructions copied. Paste them into a model block.");
    } catch { setError("Clipboard unavailable. Select and copy the instructions below, or try again."); }
  }
  async function download() {
    setBusy(true); setError(""); setNotice("");
    try {
      const [{ createOutputArtifact, downloadArtifact }, { suggestOutputFormat }] = await Promise.all([
        import("./file-export/artifact"), import("./format-selection"),
      ]);
      const selectedFormat = format === "auto" ? suggestOutputFormat(text) : format;
      const artifact = await createOutputArtifact(text, selectedFormat, name, getSecrets());
      downloadArtifact(artifact.blob, artifact.filename);
      const replaces = selectedFormat === "pdf" && (await import("./export-document")).pdfReplacesCharacters(text);
      setNotice(replaces ? "Downloaded PDF. Unsupported characters were replaced; DOCX preserves Unicode." : `Downloaded ${selectedFormat.toUpperCase()}.`);
    } catch (caught) { setError(caught instanceof FileExportError ? caught.message : "Unable to create this file. Check its content and export limits, then try again."); }
    finally { setBusy(false); }
  }
  return <div className={s.controls}>
    <label>Download as<select aria-label="Output file format" value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as DownloadFormat | "auto")}><option value="auto">Auto detect</option>{VISIBLE_DOWNLOAD_FORMATS.map((value) => <option key={value} value={value}>{value === "md" ? "Markdown" : value.toUpperCase()}</option>)}</select></label>
    <button type="button" disabled={!text.trim() || busy} onClick={() => void download()}>{busy ? "Preparing..." : "Download"}</button>
    <button type="button" disabled={busy} onClick={() => void copyInstructions()}>Format for export</button>
    {instructions && <textarea aria-label="Format for export instructions" readOnly rows={4} value={instructions} />}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>;
}
