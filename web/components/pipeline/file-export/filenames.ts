import { FileExportError, OUTPUT_FORMATS } from "./model";
import type { OutputFormat } from "./model";

export function validateExportFilename(name: string, format: OutputFormat): string {
  if (typeof name !== "string" || name.length > 80
    || !(OUTPUT_FORMATS as readonly string[]).includes(format)
    || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name)
    || name.includes("..") || /[. ]$|\. | \./.test(name)
    || name.slice(name.lastIndexOf(".")).toLowerCase() !== `.${format}`
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name.split(".")[0].trimEnd())) {
    throw new FileExportError("Unsafe export filename. Use a flat ASCII name of at most 80 characters with the matching file extension.");
  }
  return name;
}
