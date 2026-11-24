import { test, expect } from "bun:test";
import { normalize, buildPrompt } from "../src/prompt.mjs";
import { openAIResponse, parseAiSdkStream } from "../src/stream.mjs";

const encoder = new TextEncoder();
const frame = event => "data: " + JSON.stringify(event) + "\r\n\r\n";
const finish = { type: "finish", finishReason: "stop", totalUsage: { inputTokens: { total: 9 }, outputTokens: { total: 4 } } };
const events = (...values) => {
  const bytes = encoder.encode(values.map(frame).join("") + "data: [DONE]\r\n\r\n");
  return new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
    c.close();
  } });
};
const body = extra => ({ model: "fixture-model", messages: [{ role: "user", content: "ping" }], stream: true, ...extra });
const tool = { type: "function", function: { name: "echo_value", parameters: {
  type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
} } };
const chunks = text => text.split(/\n\n/).filter(x => x.startsWith("data: ") && x !== "data: [DONE]").map(x => JSON.parse(x.slice(6)));
const deltas = rows => rows.flatMap(x => x.choices?.map(c => c.delta) ?? []);

test("SSE parser handles fragmented UTF-8 and CRLF", async () => {
  const found = [];
  for await (const e of parseAiSdkStream(events({ type: "text-delta", delta: "你好🌟" }, finish))) found.push(e);
  expect(found[0].delta).toBe("你好🌟");
  expect(found[1]).toEqual(finish);
});

test("text and reasoning stream, stable ID, finish and usage", async () => {
  const response = await openAIResponse(events({ type: "reasoning-delta", delta: "think" },
    { type: "text-delta", delta: "hello" }, { type: "text-delta", delta: "世界" }, finish), normalize(body({ stream_options: { include_usage: true } })));
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text(), rows = chunks(text), ds = deltas(rows);
  expect(ds[0].role).toBe("assistant");
  expect(ds.filter(d => d.reasoning_content).map(d => d.reasoning_content).join("")).toBe("think");
  expect(ds.filter(d => d.content).map(d => d.content).join("")).toBe("hello世界");
  expect(new Set(rows.map(r => r.id)).size).toBe(1);
  expect(rows.at(-2).choices[0].finish_reason).toBe("stop");
  expect(rows.at(-1).usage).toEqual({ prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("ordinary text becomes available before upstream finish", async () => {
  let source;
  const upstream = new ReadableStream({ start(c) { source = c; } });
  const response = await openAIResponse(upstream, normalize(body()));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toContain('"role":"assistant"');
  source.enqueue(encoder.encode(frame({ type: "text-delta", delta: "first" })));
  expect(decoder.decode((await reader.read()).value)).toContain('"content":"first"');
  source.enqueue(encoder.encode(frame(finish)));
  source.close();
  while (!(await reader.read()).done) {}
});

test("native tool events become OpenAI indexed tool_calls after validation", async () => {
  const request = normalize(body({ tools: [tool], tool_choice: "required" }));
  const response = await openAIResponse(events(
    { type: "tool-input-start", toolCallId: "native_1", toolName: "echo_value" },
    { type: "tool-input-delta", toolCallId: "native_1", inputTextDelta: '{"value":' },
    { type: "tool-input-delta", toolCallId: "native_1", inputTextDelta: '"ping"}' },
    { type: "tool-input-available", toolCallId: "native_1", toolName: "echo_value", input: { value: "ping" } },
    finish), request);
  const rows = chunks(await response.text()), calls = deltas(rows).flatMap(d => d.tool_calls ?? []);
  expect(calls[0]).toEqual({ index: 0, id: "native_1", type: "function", function: { name: "echo_value", arguments: "" } });
  expect(JSON.parse(calls[1].function.arguments)).toEqual({ value: "ping" });
  expect(rows.at(-1).choices[0].finish_reason).toBe("tool_calls");
});

test("emulated tool envelope is buffered and converted for streaming/non-streaming", async () => {
  const envelope = JSON.stringify({ content: null, tool_calls: [{ name: "echo_value", arguments: { value: "ping" } }] });
  const extra = { tools: [tool], tool_choice: { type: "function", function: { name: "echo_value" } } };
  const request = normalize(body(extra));
  expect(buildPrompt(request)).toContain("Declared client tools:");
  const response = await openAIResponse(events({ type: "text-delta", delta: envelope.slice(0, 22) },
    { type: "text-delta", delta: envelope.slice(22) }, finish), request);
  const rows = chunks(await response.text()), ds = deltas(rows);
  expect(ds.some(d => d.content)).toBe(false);
  expect(ds.flatMap(d => d.tool_calls ?? [])[0].function.name).toBe("echo_value");
  expect(rows.at(-1).choices[0].finish_reason).toBe("tool_calls");
  const non = await openAIResponse(events({ type: "text-delta", delta: envelope }, finish), normalize(body({ ...extra, stream: false })));
  const result = await non.json();
  expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"value":"ping"}');
  expect(result.choices[0].finish_reason).toBe("tool_calls");
});

test("provider-executed tool is not repeated; ordinary auto response survives", async () => {
  const response = await openAIResponse(events(
    { type: "tool-input-available", toolCallId: "executed", toolName: "echo_value", input: { value: "ping" }, providerExecuted: true },
    { type: "tool-output-available", toolCallId: "executed", output: "ping" },
    { type: "text-delta", delta: "The result is ping." }, finish), normalize(body({ tools: [tool] })));
  const rows = chunks(await response.text());
  expect(deltas(rows).flatMap(d => d.tool_calls ?? [])).toEqual([]);
  expect(deltas(rows).find(d => d.content).content).toBe("The result is ping.");
});

test("invalid tool arguments, missing finish, and SSE errors do not report success", async () => {
  for (const stream of [
    events({ type: "text-delta", delta: '{"content":null,"tool_calls":[{"name":"echo_value","arguments":{"value":42}}]}' }, finish),
    events({ type: "text-delta", delta: "truncated" }),
    events({ type: "error", errorText: "private upstream detail" }),
  ]) {
    const response = await openAIResponse(stream, normalize(body({ tools: [tool], tool_choice: "required" })));
    const text = await response.text();
    expect(chunks(text).some(x => x.error)).toBe(true);
    expect(text).not.toContain("private upstream detail");
    expect(text).not.toContain('"finish_reason":"stop"');
  }
});

test("mixed roles and tool results remain in prompt history", () => {
  const request = normalize(body({ messages: [
    { role: "system", content: "system text" }, { role: "user", content: "call" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "echo_value", arguments: '{"value":"ping"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "ping" },
  ] }));
  const prompt = buildPrompt(request);
  expect(prompt).toContain("[system]");
  expect(prompt).toContain("[Tool result: call_1]");
  expect(prompt).toContain('"value":"ping"');
});
