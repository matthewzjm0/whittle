import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolCall } from "../lib/pipeline/types";
import { createWorkspaceTools } from "../lib/pipeline/tools";

const call = (name: string, args: object | string, id = "c1"): ToolCall => ({
  id, name, arguments: typeof args === "string" ? args : JSON.stringify(args),
});
const signal = () => new AbortController().signal;

async function withWorkspace(run: (root: string, outside: string) => Promise<void>): Promise<void> {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pipeline-tools-")));
  const root = path.join(base, "work");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  try { await run(root, outside); } finally { rmSync(base, { recursive: true, force: true }); }
}

export function registerToolsTests(test: (name: string, run: () => void | Promise<void>) => void) {
  test("workspace tools read, write, list, and edit files with exact-match semantics", async () => {
    await withWorkspace(async (root) => {
      const tools = await createWorkspaceTools({ root, allowCommands: false });
      assert.deepEqual(tools.specs.map((tool) => tool.name), ["read_file", "list_files", "write_file", "edit_file"]);

      assert.match(await tools.execute(call("write_file", { path: "src/a.txt", content: "one\ntwo\nthree\ntwo\n" }), signal()), /Wrote 18 bytes to src\/a\.txt/);
      assert.equal(readFileSync(path.join(root, "src/a.txt"), "utf8"), "one\ntwo\nthree\ntwo\n");
      assert.equal(await tools.execute(call("read_file", { path: "src/a.txt" }), signal()), "one\ntwo\nthree\ntwo\n");
      assert.equal(await tools.execute(call("read_file", { path: "src/a.txt", start_line: 2, max_lines: 2 }), signal()), "two\nthree");
      assert.match(await tools.execute(call("read_file", { path: "src/a.txt", start_line: 99 }), signal()), /no lines/);

      assert.equal(await tools.execute(call("list_files", {}), signal()), "src/");
      assert.equal(await tools.execute(call("list_files", { path: "src" }), signal()), "src/a.txt");
      assert.equal(await tools.execute(call("list_files", { recursive: true }), signal()), "src/\nsrc/a.txt");

      // Unique match succeeds, ambiguous and missing matches fail with guidance and change nothing.
      assert.match(await tools.execute(call("edit_file", { path: "src/a.txt", old_str: "three", new_str: "3" }), signal()), /replaced 1 occurrence\./);
      assert.match(await tools.execute(call("edit_file", { path: "src/a.txt", old_str: "two", new_str: "2" }), signal()), /matches 2 places/);
      assert.match(await tools.execute(call("edit_file", { path: "src/a.txt", old_str: "missing", new_str: "x" }), signal()), /not found/);
      assert.match(await tools.execute(call("edit_file", { path: "src/a.txt", old_str: "", new_str: "x" }), signal()), /must not be empty/);
      assert.match(await tools.execute(call("edit_file", { path: "src/a.txt", old_str: "one", new_str: "one" }), signal()), /identical/);
      assert.equal(readFileSync(path.join(root, "src/a.txt"), "utf8"), "one\ntwo\n3\ntwo\n");
      assert.match(await tools.execute(call("edit_file", { path: "src/a.txt", old_str: "two", new_str: "2", replace_all: true }), signal()), /replaced 2 occurrences/);
      // "$&" in a replacement is literal text, not a regex back-reference.
      await tools.execute(call("edit_file", { path: "src/a.txt", old_str: "one", new_str: "$&$1" }), signal());
      assert.equal(readFileSync(path.join(root, "src/a.txt"), "utf8"), "$&$1\n2\n3\n2\n");
    });
  });

  test("workspace tools reject escapes, protected files, and malformed arguments without throwing", async () => {
    await withWorkspace(async (root, outside) => {
      writeFileSync(path.join(outside, "secret.txt"), "top secret");
      writeFileSync(path.join(root, ".env"), "KEY=1");
      writeFileSync(path.join(root, ".env.example"), "KEY=");
      mkdirSync(path.join(root, ".git"));
      writeFileSync(path.join(root, ".git", "config"), "[core]");
      const tools = await createWorkspaceTools({ root, allowCommands: false });
      const error = /^Error: /;

      for (const bad of ["../outside/secret.txt", "a/../../outside/secret.txt", path.join(outside, "secret.txt"), "C:\\Windows\\win.ini", "", "a\0b"]) {
        assert.match(await tools.execute(call("read_file", { path: bad }), signal()), error, bad);
      }
      assert.match(await tools.execute(call("write_file", { path: "../escape.txt", content: "x" }), signal()), /outside the workspace/);
      assert.match(await tools.execute(call("read_file", { path: ".env" }), signal()), /protected/);
      assert.match(await tools.execute(call("write_file", { path: ".env.local", content: "x" }), signal()), /protected/);
      assert.match(await tools.execute(call("read_file", { path: ".git/config" }), signal()), /protected/);
      assert.equal(await tools.execute(call("read_file", { path: ".env.example" }), signal()), "KEY=");
      assert.equal(await tools.execute(call("list_files", {}), signal()), ".env.example");

      try {
        symlinkSync(outside, path.join(root, "link"), "dir");
        symlinkSync(path.join(outside, "secret.txt"), path.join(root, "file-link"));
        assert.match(await tools.execute(call("read_file", { path: "link/secret.txt" }), signal()), /outside the workspace/);
        assert.match(await tools.execute(call("read_file", { path: "file-link" }), signal()), /outside the workspace/);
        assert.match(await tools.execute(call("write_file", { path: "link/new.txt", content: "x" }), signal()), /outside the workspace/);
      } catch (symlinkError) {
        if (!/EPERM|EACCES/.test(String((symlinkError as { code?: string }).code))) throw symlinkError;
      }

      assert.match(await tools.execute(call("read_file", "not json"), signal()), /valid JSON/);
      assert.match(await tools.execute(call("read_file", "[]"), signal()), /JSON object/);
      assert.match(await tools.execute(call("read_file", {}), signal()), /path must be/);
      assert.match(await tools.execute(call("write_file", { path: "a.txt" }), signal()), /content is required/);
      assert.match(await tools.execute(call("write_file", { path: "a.txt", content: 5 }), signal()), /content must be a string/);
      assert.match(await tools.execute(call("read_file", { path: "a.txt", start_line: 0 }), signal()), /integer from 1/);
      assert.match(await tools.execute(call("read_file", { path: "missing.txt" }), signal()), /not found/);
      assert.match(await tools.execute(call("no_such_tool", {}), signal()), /unknown tool/);
      // Error text never reveals absolute paths.
      assert.equal((await tools.execute(call("read_file", { path: "missing.txt" }), signal())).includes(root), false);
      assert.equal(readFileSync(path.join(outside, "secret.txt"), "utf8"), "top secret");
    });
  });

  test("workspace tools bound file size, binary reads, and returned text", async () => {
    await withWorkspace(async (root) => {
      const tools = await createWorkspaceTools({ root, allowCommands: false, maxFileBytes: 2048, maxResultChars: 300 });
      assert.match(await tools.execute(call("write_file", { path: "big.txt", content: "x".repeat(3000) }), signal()), /larger than/);
      writeFileSync(path.join(root, "long.txt"), "y".repeat(2000));
      const long = await tools.execute(call("read_file", { path: "long.txt" }), signal());
      assert.match(long, /truncated 1700 more characters/);
      writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
      assert.match(await tools.execute(call("read_file", { path: "bin.dat" }), signal()), /binary/);
      writeFileSync(path.join(root, "huge.txt"), "z".repeat(5000));
      assert.match(await tools.execute(call("read_file", { path: "huge.txt" }), signal()), /larger than/);
      assert.match(await tools.execute(call("list_files", { path: "long.txt" }), signal()), /not a directory/);
    });
  });

  test("run_command is off by default and only advertised when enabled", async () => {
    await withWorkspace(async (root) => {
      const previous = process.env.PIPELINE_ALLOW_COMMANDS;
      delete process.env.PIPELINE_ALLOW_COMMANDS;
      try {
        const off = await createWorkspaceTools({ root });
        assert.equal(off.specs.some((tool) => tool.name === "run_command"), false);
        assert.match(await off.execute(call("run_command", { command: "echo hi" }), signal()), /disabled/);
        process.env.PIPELINE_ALLOW_COMMANDS = "true";
        assert.equal((await createWorkspaceTools({ root })).specs.some((tool) => tool.name === "run_command"), true);
        assert.equal((await createWorkspaceTools({ root, allowCommands: false })).specs.some((tool) => tool.name === "run_command"), false);
      } finally {
        if (previous === undefined) delete process.env.PIPELINE_ALLOW_COMMANDS; else process.env.PIPELINE_ALLOW_COMMANDS = previous;
      }
    });
  });

  test("run_command runs in the workspace with exit codes, a minimal environment, timeouts, and output caps", async () => {
    await withWorkspace(async (root) => {
      const tools = await createWorkspaceTools({ root, allowCommands: true, maxResultChars: 400 });
      writeFileSync(path.join(root, "marker.txt"), "present");

      const echoed = await tools.execute(call("run_command", { command: "echo hello" }), signal());
      assert.match(echoed, /^exit code: 0\nhello/);
      const failed = await tools.execute(call("run_command", { command: "exit 3" }), signal());
      assert.match(failed, /^exit code: 3/);
      const listing = await tools.execute(call("run_command", { command: process.platform === "win32" ? "dir /b" : "ls" }), signal());
      assert.match(listing, /marker\.txt/);

      // Server-side secrets are not inherited.
      process.env.PIPELINE_TEST_SECRET = "leaked";
      try {
        const env = await tools.execute(call("run_command", { command: "node -e \"process.stdout.write(process.env.PIPELINE_TEST_SECRET || 'none')\"" }), signal());
        assert.match(env, /none$/);
      } finally { delete process.env.PIPELINE_TEST_SECRET; }

      // Long output keeps the end and says what was dropped.
      const loud = await tools.execute(call("run_command", { command: "node -e \"process.stdout.write('a'.repeat(5000)+'END')\"" }), signal());
      assert.match(loud, /output truncated: \d+ earlier characters omitted/);
      assert.match(loud, /END$/);
      assert.ok(loud.length < 600);

      // A runaway command is killed at the timeout.
      const started = Date.now();
      const slow = await tools.execute(call("run_command", { command: "node -e \"setTimeout(() => {}, 30000)\"", timeout_seconds: 1 }), signal());
      assert.match(slow, /timed out after 1s and was killed/);
      assert.ok(Date.now() - started < 10_000);
    });
  });

  test("run_command stops promptly when the run is cancelled", async () => {
    await withWorkspace(async (root) => {
      const tools = await createWorkspaceTools({ root, allowCommands: true });
      const controller = new AbortController();
      const started = Date.now();
      const running = tools.execute(call("run_command", { command: "node -e \"setTimeout(() => {}, 30000)\"" }), controller.signal);
      setTimeout(() => controller.abort(), 200);
      await assert.rejects(running, { code: "cancelled" });
      assert.ok(Date.now() - started < 5000);
      const already = new AbortController();
      already.abort();
      await assert.rejects(tools.execute(call("read_file", { path: "a.txt" }), already.signal), { code: "cancelled" });
    });
  });

  test("workspace tools require an existing absolute directory", async () => {
    await assert.rejects(createWorkspaceTools({ root: "relative/path" }), { code: "request" });
    await assert.rejects(createWorkspaceTools({ root: path.join(os.tmpdir(), "pipeline-tools-does-not-exist") }), { code: "request" });
  });
}
