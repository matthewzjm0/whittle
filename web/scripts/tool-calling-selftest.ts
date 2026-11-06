import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Message, StudioModel, ToolSpec } from "../lib/pipeline/types";
import { LIMITS } from "../lib/pipeline/limits";
import { createComplete } from "../lib/pipeline/provider";
import { assertContext, validateCompletion, validateRequest, validateToolCalls, validateToolSpecs } from "../lib/pipeline/validation";

const readFile: ToolSpec = {
  name: "read_file",
  description: "Read a text file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const model = (baseUrl = "http://127.0.0.1:1"): StudioModel => ({
  id: "m", name: "m", model: "tool-model", baseUrl, contextWindow: 8192,
});

const signal = () => new AbortController().signal;

export function registerToolCallingTests(test: (name: string, run: () => void | Promise<void>) => void) {
  test("tool specs reject bad names, duplicates, oversize schemas, and extra keys", () => {
    validateToolSpecs([readFile]);
    assert.throws(() => validateToolSpecs([]), { code: "request" });
    assert.throws(() => validateToolSpecs([{ ...readFile, name: "bad name" }]), { code: "request" });
    assert.throws(() => validateToolSpecs([{ ...readFile, name: "" }]), { code: "request" });
    assert.throws(() => validateToolSpecs([readFile, readFile]), { code: "request" });
    assert.throws(() => validateToolSpecs([{ ...readFile, extra: true }]), { code: "request" });
    assert.throws(() => validateToolSpecs([{ ...readFile, parameters: "nope" }]), { code: "request" });
    const big = { type: "object", properties: { x: { type: "string", description: "x".repeat(LIMITS.toolSchemaChars) } } };
    assert.throws(() => validateToolSpecs([{ ...readFile, parameters: big }]), { code: "request" });
    const many = Array.from({ length: LIMITS.tools + 1 }, (_, i) => ({ ...readFile, name: `tool_${i}` }));
    assert.throws(() => validateToolSpecs(many), { code: "request" });
  });

  test("tool calls from a model are bounded and must have unique safe ids and names", () => {
    validateToolCalls([{ id: "call_1", name: "read_file", arguments: "{\"path\":\"a\"}" }]);
    assert.throws(() => validateToolCalls([], "response"), { code: "response" });
    assert.throws(() => validateToolCalls([{ id: "a", name: "x", arguments: "{}" }, { id: "a", name: "y", arguments: "{}" }], "response"), { code: "response" });
    assert.throws(() => validateToolCalls([{ id: "a", name: "../etc", arguments: "{}" }]), { code: "request" });
    assert.throws(() => validateToolCalls([{ id: "a", name: "x", arguments: "y".repeat(LIMITS.toolArgumentChars + 1) }]), { code: "request" });
    assert.throws(() => validateToolCalls([{ id: "a", name: "x", arguments: "{}", extra: 1 }]), { code: "request" });
    const tooMany = Array.from({ length: LIMITS.toolCallsPerReply + 1 }, (_, i) => ({ id: `c${i}`, name: "x", arguments: "{}" }));
    assert.throws(() => validateToolCalls(tooMany), { code: "request" });
    assert.deepEqual(validateCompletion({ text: "", toolCalls: [{ id: "a", name: "x", arguments: "{}" }] }),
      { text: "", toolCalls: [{ id: "a", name: "x", arguments: "{}" }] });
    assert.deepEqual(validateCompletion({ text: "plain" }), { text: "plain" });
  });

  test("tool messages are rejected at the browser boundary but accepted internally", () => {
    const withTools: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
      { role: "tool", content: "file text", toolCallId: "c1" },
    ];
    assertContext(model(), withTools, 64, { allowToolMessages: true });
    assert.throws(() => assertContext(model(), withTools, 64), { code: "request" });
    assert.throws(() => validateRequest({ mode: "chat", model: model(), messages: withTools, maxOutputTokens: 64 }));
    // Structural rules still apply internally.
    assert.throws(() => assertContext(model(), [{ role: "tool", content: "x" }], 64, { allowToolMessages: true }), { code: "request" });
    assert.throws(() => assertContext(model(), [{ role: "user", content: "x", toolCallId: "c1" }], 64, { allowToolMessages: true }), { code: "request" });
    assert.throws(() => assertContext(model(), [{ role: "user", content: "x", toolCalls: [{ id: "a", name: "x", arguments: "{}" }] }], 64, { allowToolMessages: true }), { code: "request" });
    // Tool definitions count against the context window.
    assert.throws(() => assertContext({ ...model(), contextWindow: 300 }, [{ role: "user", content: "hi" }], 64, { allowToolMessages: true, extraInputTokens: 500 }), { code: "context" });
  });

  test("provider sends OpenAI tool wire format and parses tool-call replies", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let reply: unknown;
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      outgoing.writeHead(200, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify(reply));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const m = model(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const complete = createComplete({ allowLoopback: true });

      // Tool-call-only reply: null content, call arguments as a JSON string.
      reply = { choices: [{ message: { content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      const first = await complete(m, [{ role: "user", content: "read a.txt" }], 64, signal(), undefined, [readFile]);
      assert.deepEqual(first.toolCalls, [{ id: "call_9", name: "read_file", arguments: "{\"path\":\"a.txt\"}" }]);
      assert.equal(first.text, "");
      assert.deepEqual(first.usage, { input: 10, output: 5 });
      assert.deepEqual(bodies[0].tools, [{ type: "function", function: { name: "read_file", description: "Read a text file.", parameters: readFile.parameters } }]);
      assert.equal(bodies[0].tool_choice, "auto");

      // Follow-up turn: assistant tool call and tool result in wire format.
      reply = { choices: [{ message: { content: "It says hello." } }] };
      const second = await complete(m, [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "", toolCalls: first.toolCalls },
        { role: "tool", content: "hello", toolCallId: "call_9" },
      ], 64, signal(), undefined, [readFile]);
      assert.equal(second.text, "It says hello.");
      assert.equal(second.toolCalls, undefined);
      assert.deepEqual(bodies[1].messages, [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] },
        { role: "tool", tool_call_id: "call_9", content: "hello" },
      ]);

      // Servers that return arguments as an object are normalized to JSON text.
      reply = { choices: [{ message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: { path: "b" } } }] } }] };
      const third = await complete(m, [{ role: "user", content: "x" }], 64, signal(), undefined, [readFile]);
      assert.equal(third.toolCalls?.[0].arguments, "{\"path\":\"b\"}");

      // Without tools, the payload has no tool fields and stray tool_calls are ignored.
      reply = { choices: [{ message: { content: "plain", tool_calls: [{ id: "z", type: "function", function: { name: "read_file", arguments: "{}" } }] } }] };
      const plain = await complete(m, [{ role: "user", content: "x" }], 64, signal());
      assert.deepEqual(plain, { text: "plain" });
      assert.equal("tools" in bodies[3], false);
      assert.equal("tool_choice" in bodies[3], false);

      // Missing text without tool calls is still an error.
      reply = { choices: [{ message: { content: null } }] };
      await assert.rejects(complete(m, [{ role: "user", content: "x" }], 64, signal(), undefined, [readFile]), { code: "response" });

      // Malformed or excessive tool calls from the model are rejected as response errors.
      reply = { choices: [{ message: { content: "", tool_calls: [{ id: "a", type: "function", function: { name: "bad name", arguments: "{}" } }] } }] };
      await assert.rejects(complete(m, [{ role: "user", content: "x" }], 64, signal(), undefined, [readFile]), { code: "response" });

      // Invalid tool definitions never reach the network.
      const before = bodies.length;
      await assert.rejects(complete(m, [{ role: "user", content: "x" }], 64, signal(), undefined, [{ ...readFile, name: "no spaces" }]), { code: "request" });
      assert.equal(bodies.length, before);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
