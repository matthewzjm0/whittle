// Server-only workspace tools for agent blocks. Not exported from ./index (that entry stays browser-safe).
//
// SECURITY MODEL
// - File tools are confined to one workspace folder: relative paths only, no "..", and symlinks that
//   resolve outside the folder are rejected. `.git` and `.env*` files are blocked for reading and writing.
// - `run_command` is NOT a sandbox. A shell command can reach anything the server process can. It is
//   therefore disabled unless PIPELINE_ALLOW_COMMANDS=true (or allowCommands is set explicitly) and
//   should only be enabled on a trusted local machine. Commands run with a minimal environment so
//   server-side API keys are not inherited, and with a timeout and an output cap.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolCall, ToolSpec } from "./types";
import { checkAbort, PipelineError } from "./limits";

export interface WorkspaceToolOptions {
  /** Absolute path of the workspace folder. Must exist. */
  root: string;
  /** Enable run_command. Defaults to PIPELINE_ALLOW_COMMANDS === "true". */
  allowCommands?: boolean;
  /** Default and maximum command runtime. Defaults to 60 s; capped at 10 min. */
  commandTimeoutMs?: number;
  /** Maximum characters returned to the model per tool call. Defaults to 16,000. */
  maxResultChars?: number;
  /** Maximum size of a file that can be read or written. Defaults to 1 MiB. */
  maxFileBytes?: number;
}

export interface WorkspaceTools {
  specs: ToolSpec[];
  /** Runs one tool call. Tool failures come back as "Error: ..." text for the model; only cancellation throws. */
  execute(call: ToolCall, signal: AbortSignal): Promise<string>;
}

const MAX_COMMAND_MS = 600_000;
const MAX_LIST_ENTRIES = 500;
const MAX_LIST_DEPTH = 6;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const ENV_EXAMPLE = /^\.env\.(?:example|sample|template)$/i;
const ENV_FILE = /^\.env(?:\..*)?$/i;

class ToolError extends Error {}

const spec = (name: string, description: string, properties: Record<string, object>, required: string[]): ToolSpec => ({
  name, description, parameters: { type: "object", properties, required },
});

const READ_SPEC = spec("read_file",
  "Read a text file in the workspace. Optionally read a range of lines for large files.",
  {
    path: { type: "string", description: "File path relative to the workspace root." },
    start_line: { type: "integer", description: "1-based first line to return (default 1)." },
    max_lines: { type: "integer", description: "Maximum number of lines to return." },
  }, ["path"]);

const LIST_SPEC = spec("list_files",
  "List files and folders in a workspace directory. Folders end with '/'. node_modules and .git are skipped.",
  {
    path: { type: "string", description: "Directory relative to the workspace root (default '.')." },
    recursive: { type: "boolean", description: "Include subdirectories, up to a bounded depth." },
  }, []);

const WRITE_SPEC = spec("write_file",
  "Create a file, or completely replace an existing one. Parent folders are created. Prefer edit_file for small changes.",
  {
    path: { type: "string", description: "File path relative to the workspace root." },
    content: { type: "string", description: "Full new file content." },
  }, ["path", "content"]);

const EDIT_SPEC = spec("edit_file",
  "Replace exact text in a file. old_str must match exactly once (including whitespace) unless replace_all is true.",
  {
    path: { type: "string", description: "File path relative to the workspace root." },
    old_str: { type: "string", description: "Exact text to find." },
    new_str: { type: "string", description: "Replacement text (may be empty to delete)." },
    replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
  }, ["path", "old_str", "new_str"]);

const COMMAND_SPEC = spec("run_command",
  "Run a shell command with the workspace as the working directory. Returns the exit code and the end of the combined output.",
  {
    command: { type: "string", description: "The shell command line." },
    timeout_seconds: { type: "integer", description: "Optional shorter timeout in seconds." },
  }, ["command"]);

function isInside(rootReal: string, target: string): boolean {
  const relative = path.relative(rootReal, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isProtected(relative: string): boolean {
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.includes(".git")) return true;
  const base = segments[segments.length - 1] ?? "";
  return ENV_FILE.test(base) && !ENV_EXAMPLE.test(base);
}

async function resolveInside(rootReal: string, requested: unknown): Promise<string> {
  if (typeof requested !== "string" || requested.length === 0 || requested.length > 1024 || requested.includes("\0")) {
    throw new ToolError("path must be a non-empty string.");
  }
  if (path.isAbsolute(requested) || /^[A-Za-z]:/.test(requested)) throw new ToolError("use a path relative to the workspace root.");
  const full = path.resolve(rootReal, requested);
  if (!isInside(rootReal, full)) throw new ToolError("path is outside the workspace.");
  if (isProtected(path.relative(rootReal, full))) throw new ToolError("this path is protected (.git and .env files are not accessible).");
  // Resolve symlinks on the deepest existing ancestor so a link cannot lead out of the workspace.
  let probe = full;
  for (;;) {
    try {
      if (!isInside(rootReal, await fs.realpath(probe))) throw new ToolError("path is outside the workspace.");
      break;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ToolError("path cannot be accessed.");
      const parent = path.dirname(probe);
      if (parent === probe || !isInside(rootReal, parent)) throw new ToolError("path is outside the workspace.");
      probe = parent;
    }
  }
  return full;
}

function describeFsError(error: unknown, relative: string): ToolError {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return new ToolError(`${relative} was not found.`);
  if (code === "EISDIR") return new ToolError(`${relative} is a directory.`);
  if (code === "ENOTDIR") return new ToolError(`a parent of ${relative} is not a directory.`);
  if (code === "EACCES" || code === "EPERM") return new ToolError(`permission denied for ${relative}.`);
  return new ToolError(`could not access ${relative}.`);
}

function parseArguments(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw === "" ? "{}" : raw); } catch { throw new ToolError("arguments must be valid JSON."); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ToolError("arguments must be a JSON object.");
  return parsed as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new ToolError(`${name} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new ToolError(`${name} must be a string.`);
  return value;
}

function intArg(args: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ToolError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function boolArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new ToolError(`${name} must be a boolean.`);
  return value;
}

function limitText(text: string, max: number, hint: string): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} more characters. ${hint}]`;
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "HOME", "USERPROFILE", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TERM"];
  const env: Record<string, string> = { CI: "1" };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Some setups (Next.js) make NODE_ENV a required member of ProcessEnv. It is deliberately not passed to commands.
  return env as unknown as NodeJS.ProcessEnv;
}

function runCommand(command: string, cwd: string, timeoutMs: number, maxChars: number, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    checkAbort(signal);
    const windows = process.platform === "win32";
    const spawnOptions: SpawnOptions = {
      shell: true, cwd, env: commandEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: !windows, windowsHide: true,
    };
    const child: ChildProcess = spawn(command, spawnOptions);
    let tail = "";
    let dropped = 0;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const kill = () => {
      try {
        if (windows) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    };
    const collect = (chunk: Buffer) => {
      tail += chunk.toString("utf8");
      if (tail.length > maxChars * 2) {
        const keep = tail.slice(tail.length - maxChars);
        dropped += tail.length - keep.length;
        tail = keep;
      }
    };
    const report = (status: string) => {
      const output = tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
      const omitted = dropped + (tail.length - output.length);
      return `${status}\n${omitted > 0 ? `[output truncated: ${omitted} earlier characters omitted]\n` : ""}${output}`;
    };
    const onAbort = () => {
      cancelled = true;
      kill();
      finish(() => reject(new PipelineError("cancelled")));
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", () => finish(() => resolve("Error: the command could not be started.")));
    child.on("close", (code: number | null) => finish(() => {
      if (cancelled) reject(new PipelineError("cancelled"));
      else if (timedOut) resolve(report(`Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`));
      else resolve(report(`exit code: ${code ?? "unknown"}`));
    }));
  });
}

export async function createWorkspaceTools(options: WorkspaceToolOptions): Promise<WorkspaceTools> {
  if (typeof options.root !== "string" || !path.isAbsolute(options.root)) throw new PipelineError("request");
  let rootReal: string;
  try {
    rootReal = await fs.realpath(options.root);
    if (!(await fs.stat(rootReal)).isDirectory()) throw new Error("not a directory");
  } catch { throw new PipelineError("request"); }

  const allowCommands = options.allowCommands ?? (process.env.PIPELINE_ALLOW_COMMANDS === "true");
  const maxResultChars = Math.min(200_000, Math.max(256, options.maxResultChars ?? 16_000));
  const maxFileBytes = Math.min(16 * 1024 * 1024, Math.max(1024, options.maxFileBytes ?? 1_048_576));
  const defaultTimeoutMs = Math.min(MAX_COMMAND_MS, Math.max(1, options.commandTimeoutMs ?? 60_000));
  const specs = [READ_SPEC, LIST_SPEC, WRITE_SPEC, EDIT_SPEC, ...(allowCommands ? [COMMAND_SPEC] : [])];
  const relativeName = (full: string) => path.relative(rootReal, full).split(path.sep).join("/") || ".";

  async function readText(full: string): Promise<string> {
    const relative = relativeName(full);
    let stat;
    try { stat = await fs.stat(full); } catch (error) { throw describeFsError(error, relative); }
    if (!stat.isFile()) throw new ToolError(`${relative} is not a regular file.`);
    if (stat.size > maxFileBytes) throw new ToolError(`${relative} is larger than the ${maxFileBytes}-byte limit.`);
    let buffer: Buffer;
    try { buffer = await fs.readFile(full); } catch (error) { throw describeFsError(error, relative); }
    if (buffer.subarray(0, 8192).includes(0)) throw new ToolError(`${relative} looks like a binary file.`);
    return buffer.toString("utf8");
  }

  async function listDirectory(full: string, recursive: boolean): Promise<string> {
    const lines: string[] = [];
    let truncated = false;
    async function walk(directory: string, depth: number): Promise<void> {
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { throw describeFsError(error, relativeName(directory)); }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= MAX_LIST_ENTRIES) { truncated = true; return; }
        const child = path.join(directory, entry.name);
        if (isProtected(path.relative(rootReal, child))) continue;
        if (entry.isDirectory()) {
          if (SKIPPED_DIRS.has(entry.name)) continue;
          lines.push(`${relativeName(child)}/`);
          if (recursive && depth < MAX_LIST_DEPTH) await walk(child, depth + 1);
        } else {
          lines.push(relativeName(child));
        }
      }
    }
    const stat = await fs.stat(full).catch((error) => { throw describeFsError(error, relativeName(full)); });
    if (!stat.isDirectory()) throw new ToolError(`${relativeName(full)} is not a directory.`);
    await walk(full, 0);
    if (lines.length === 0) return "(empty)";
    return lines.join("\n") + (truncated ? `\n[listing stopped at ${MAX_LIST_ENTRIES} entries]` : "");
  }

  async function execute(call: ToolCall, signal: AbortSignal): Promise<string> {
    checkAbort(signal);
    try {
      const args = parseArguments(call.arguments);
      switch (call.name) {
        case "read_file": {
          const start = intArg(args, "start_line", 1, 10_000_000) ?? 1;
          const count = intArg(args, "max_lines", 1, 10_000_000);
          const full = await resolveInside(rootReal, args.path);
          const text = await readText(full);
          if (start === 1 && count === undefined) return limitText(text, maxResultChars, "Use start_line and max_lines to read the rest.");
          const lines = text.split("\n");
          const slice = lines.slice(start - 1, count === undefined ? undefined : start - 1 + count);
          if (slice.length === 0) return `(no lines: the file has ${lines.length} lines)`;
          return limitText(slice.join("\n"), maxResultChars, "Request a smaller range.");
        }
        case "list_files": {
          const requested = stringArg(args, "path", false);
          const full = await resolveInside(rootReal, requested === undefined || requested === "" ? "." : requested);
          return limitText(await listDirectory(full, boolArg(args, "recursive")), maxResultChars, "List a subdirectory instead.");
        }
        case "write_file": {
          const full = await resolveInside(rootReal, args.path);
          const content = stringArg(args, "content") as string;
          if (Buffer.byteLength(content) > maxFileBytes) throw new ToolError(`content is larger than the ${maxFileBytes}-byte limit.`);
          try {
            await fs.mkdir(path.dirname(full), { recursive: true });
            await fs.writeFile(full, content, "utf8");
          } catch (error) { throw describeFsError(error, relativeName(full)); }
          return `Wrote ${Buffer.byteLength(content)} bytes to ${relativeName(full)}.`;
        }
        case "edit_file": {
          const full = await resolveInside(rootReal, args.path);
          const oldStr = stringArg(args, "old_str") as string;
          const newStr = stringArg(args, "new_str") as string;
          const replaceAll = boolArg(args, "replace_all");
          if (oldStr === "") throw new ToolError("old_str must not be empty. Use write_file to create a file.");
          if (oldStr === newStr) throw new ToolError("old_str and new_str are identical.");
          const text = await readText(full);
          const parts = text.split(oldStr);
          const matches = parts.length - 1;
          if (matches === 0) throw new ToolError("old_str was not found. Check whitespace and read the file again.");
          if (matches > 1 && !replaceAll) throw new ToolError(`old_str matches ${matches} places. Add surrounding context to make it unique, or set replace_all.`);
          const updated = replaceAll ? parts.join(newStr) : parts[0] + newStr + parts.slice(1).join(oldStr);
          if (Buffer.byteLength(updated) > maxFileBytes) throw new ToolError(`the edited file would exceed the ${maxFileBytes}-byte limit.`);
          try { await fs.writeFile(full, updated, "utf8"); } catch (error) { throw describeFsError(error, relativeName(full)); }
          return `Edited ${relativeName(full)}: replaced ${replaceAll ? matches : 1} occurrence${(replaceAll ? matches : 1) === 1 ? "" : "s"}.`;
        }
        case "run_command": {
          if (!allowCommands) throw new ToolError("run_command is disabled on this server.");
          const command = stringArg(args, "command") as string;
          if (command.trim() === "" || command.length > 8192 || command.includes("\0")) throw new ToolError("command must be a non-empty string under 8192 characters.");
          const seconds = intArg(args, "timeout_seconds", 1, MAX_COMMAND_MS / 1000);
          const timeoutMs = seconds === undefined ? defaultTimeoutMs : Math.min(seconds * 1000, defaultTimeoutMs);
          return await runCommand(command, rootReal, timeoutMs, maxResultChars, signal);
        }
        default:
          throw new ToolError(`unknown tool "${call.name.slice(0, 64)}".`);
      }
    } catch (error) {
      if (error instanceof PipelineError) throw error;
      if (error instanceof ToolError) return `Error: ${error.message}`;
      return "Error: the tool failed unexpectedly.";
    }
  }

  return { specs, execute };
}
