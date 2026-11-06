import { EXPORT_LIMITS, FileExportError } from "./model";
import type { ExportData, OutputFormat } from "./model";
import type { FilesExportSpec } from "./spec";
import { specData, specStrings } from "./spec";
import { checkArtifact, checkData, checkSecrets } from "./safety";
import { validateExportFilename } from "./filenames";

export type ZipEntry = { name: string; format: OutputFormat; blob: Blob };
type DataArtifactFactory = (data: ExportData, format: OutputFormat) => Promise<Blob>;

export async function createZipBundle(entries: ZipEntry[]): Promise<Blob> {
  if (!entries.length || entries.length > EXPORT_LIMITS.files) throw new FileExportError("ZIP requires 1-16 files.");
  const names = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const name = validateExportFilename(entry.name, entry.format).toLowerCase();
    if (names.has(name)) throw new FileExportError("ZIP filenames must be unique ignoring case.");
    names.add(name);
    checkArtifact(entry.blob);
    total += entry.blob.size;
    if (total > EXPORT_LIMITS.bundleBytes) throw new FileExportError("ZIP contents exceed the 16 MiB total limit.");
  }
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) files[entry.name] = new Uint8Array(await entry.blob.arrayBuffer());
  const { zipSync } = await import("fflate");
  const blob = new Blob([zipSync(files, { level: 6 })], { type: "application/zip" });
  if (!blob.size || blob.size > EXPORT_LIMITS.bundleBytes) throw new FileExportError("Generated ZIP exceeds the 16 MiB total limit.");
  return blob;
}

export async function createZipArtifact(spec: FilesExportSpec, secrets: readonly string[], createFile: DataArtifactFactory): Promise<Blob> {
  if (!spec.files.length || spec.files.length > EXPORT_LIMITS.files) throw new FileExportError("ZIP requires 1-16 files.");
  checkSecrets(specStrings(spec), secrets);
  const entries: ZipEntry[] = [];
  let total = 0;
  for (const file of spec.files) {
    validateExportFilename(file.name, file.format);
    const data = specData(file.content, file.name);
    checkData(data, secrets);
    const blob = checkArtifact(await createFile(data, file.format));
    total += blob.size;
    if (total > EXPORT_LIMITS.bundleBytes) throw new FileExportError("ZIP contents exceed the 16 MiB total limit.");
    entries.push({ name: file.name, format: file.format, blob });
  }
  return createZipBundle(entries);
}
