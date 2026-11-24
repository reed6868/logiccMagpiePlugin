// AI SDK v6 SSE adapter. Parser and tool-mode boundaries adapted from
// logicc2api/server.mjs and protocols.mjs (MIT; see LICENSE).
import { LogiccError } from "./auth.mjs";
import { parseToolOutput } from "./prompt.mjs";

const MAX_FRAME = 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_TOOL_BLOCK = 2 * 1024 * 1024;
const MAX_PREFIX = 256;
const DONE = Symbol("done");

export async function* parseAiSdkStream(body) {
  if (!body) throw new LogiccError(502, "Logicc response has no body.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n").trim();
    if (!data) return null;
    if (data === "[DONE]") return DONE;
    try { return JSON.parse(data); } catch { throw new LogiccError(502, "Malformed Logicc SSE event."); }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        if (separator.index > MAX_FRAME) throw new LogiccError(502, "Logicc SSE frame is too large.");
        const event = parse(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
        if (event === DONE) return;
        if (event) yield event;
      }
      if (buffer.length > MAX_FRAME) throw new LogiccError(502, "Logicc SSE frame is too large.");
      if (done) break;
    }
    if (buffer.trim()) { const event = parse(buffer); if (event && event !== DONE) yield event; }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

export function usageOf(event) {
  const usage = event.totalUsage ?? event.usage ?? event.messageMetadata?.usage;
  if (!usage) return undefined;
  const number = v => typeof v === "number" ? v : v?.total;
  const input = number(usage.inputTokens) ?? usage.prompt_tokens;
  const output = number(usage.outputTokens) ?? usage.completion_tokens;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return undefined;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

// Only an initial tool envelope can delay text. A normal answer, including
// ordinary JSON/code fences, is released as soon as its prefix diverges.
// Legacy content-first envelopes are recognized within the same bounded probe.
export function classifyToolPrefix(text) {
  let rest = text.trimStart();
  const match = token => {
    if (rest.startsWith(token)) { rest = rest.slice(token.length).trimStart(); return "match"; }
    return token.startsWith(rest) ? "prefix" : "plain";
  };
  if (!rest) return "prefix";
  if (rest.startsWith("\x60")) {
    const fence = match("\x60\x60\x60");
    if (fence !== "match") return fence;
    if (/^[jJ]/.test(rest)) {
      const json = rest.toLowerCase();
      if ("json".startsWith(json) && json.length < 4) return "prefix";
      if (!/^json(?:\s|\{)/i.test(rest) && json !== "json") return "plain";
      rest = rest.slice(4).trimStart();
    }
  }
  const object = match("{");
  if (object !== "match") return object;
  const key = match('"tool_calls"');
  if (key === "match") {
    const colon = match(":");
    return colon === "match" ? "tool" : colon;
  }
  if (key === "prefix") return key;
  const legacy = match('"content"');
  if (legacy !== "match") return legacy;
  const colon = match(":");
  if (colon !== "match") return colon;
  if (rest.startsWith('"')) {
    const string = /^"(?:[^"\\\x00-\x1f]|\\[^\x00-\x1f])*"/.exec(rest);
    if (!string) return "prefix";
    rest = rest.slice(string[0].length).trimStart();
  } else {
    const nil = match("null");
    if (nil !== "match") return nil;
  }
  const comma = match(",");
  if (comma !== "match") return comma;
  const calls = match('"tool_calls"');
  if (calls !== "match") return calls;
  const delimiter = match(":");
  return delimiter === "match" ? "tool" : delimiter;
}

async function* parts(body, req) {
  let text = "", bytes = 0, finished = false, reason = "stop", usage;
  const native = new Map();
  const toolMode = req.active.length > 0;
  let mode = toolMode ? "prefix" : "plain";
  const account = delta => {
    bytes += Buffer.byteLength(delta);
    if (bytes > MAX_OUTPUT) throw new LogiccError(502, "Logicc output is too large.");
  };
  for await (const event of parseAiSdkStream(body)) {
    if (!event || typeof event !== "object") throw new LogiccError(502, "Invalid Logicc SSE event.");
    if (event.type === "error" || event.type === "abort") throw new LogiccError(502, "Logicc stream reported an error.");
    if (event.type === "text-delta" && typeof event.delta === "string" && event.delta) {
      account(event.delta);
      if (mode === "plain") yield { content: event.delta };
      else if (mode === "prefix") {
        // Limit the probe even when an upstream event contains a long delta.
        const combined = text + event.delta;
        const next = classifyToolPrefix(combined.slice(0, MAX_PREFIX));
        if (next === "tool") {
          mode = "tool";
          text = combined;
        } else if (next === "plain" || combined.length >= MAX_PREFIX) {
          mode = "plain";
          text = "";
          yield { content: combined };
        } else text = combined;
      } else text += event.delta;
      if (mode === "tool" && text.length > MAX_TOOL_BLOCK) throw new LogiccError(502, "Logicc tool envelope is too large.");
    } else if (event.type === "reasoning-delta" && typeof event.delta === "string" && event.delta) {
      account(event.delta);
      yield { reasoning_content: event.delta };
    } else if (toolMode && ["tool-input-start", "tool-input-available"].includes(event.type)) {
      const id = event.toolCallId ?? event.id;
      const old = native.get(id);
      const name = event.toolName ?? old?.name;
      if (typeof id === "string" && req.active.some(t => t.name === name)) {
        if (!old && native.size >= 32) throw new LogiccError(502, "Too many native tool calls.");
        const call = old ?? { id, name, arguments: "", executed: false };
        if (event.input !== undefined) {
          account(JSON.stringify(event.input));
          call.arguments = event.input;
        }
        call.executed ||= event.providerExecuted === true;
        native.set(id, call);
      }
    } else if (toolMode && event.type === "tool-input-delta") {
      const call = native.get(event.toolCallId ?? event.id);
      const delta = event.inputTextDelta ?? event.delta;
      if (call && typeof call.arguments === "string" && typeof delta === "string") {
        account(delta);
        call.arguments += delta;
      }
    } else if (["tool-output-available", "tool-output-error", "tool-output-denied"].includes(event.type)) {
      const call = native.get(event.toolCallId ?? event.id);
      if (call) call.executed = true;
    }
    usage = usageOf(event) ?? usage;
    if (event.type === "finish") {
      finished = true;
      reason = ["stop", "length", "content_filter"].includes(event.finishReason) ? event.finishReason : "stop";
    }
  }
  if (!finished) throw new LogiccError(502, "Logicc stream ended before its finish event.");
  if (toolMode) {
    const pending = [...native.values()].filter(c => !c.executed);
    // Native calls stay pending until finish because the provider may execute
    // them itself. Never return a raw envelope alongside native tool calls.
    let result;
    if (mode === "tool") {
      const envelope = parseToolOutput(text, pending.length ? { ...req, required: false } : req, [], { requireEnvelope: true });
      result = pending.length ? { text: envelope.text, calls: parseToolOutput("", req, pending).calls } : envelope;
    } else if (pending.length) {
      result = parseToolOutput(text, req, pending);
    } else {
      if (req.required) throw new LogiccError(502, "Model did not return a valid required tool call.");
      result = { text, calls: [] };
    }
    const executedNames = new Set([...native.values()].filter(c => c.executed).map(c => c.name));
    if (!pending.length && result.calls.some(c => executedNames.has(c.function.name))) {
      throw new LogiccError(502, "Refusing to repeat a provider-executed tool call.");
    }
    if (result.text) yield { content: result.text };
    for (let index = 0; index < result.calls.length; index++) {
      const c = result.calls[index];
      yield { tool_calls: [{ index, id: c.id, type: "function", function: { name: c.function.name, arguments: "" } }] };
      yield { tool_calls: [{ index, function: { arguments: c.function.arguments } }] };
    }
    if (result.calls.length) reason = "tool_calls";
  }
  yield { finish: reason, usage };
}

export function errorResponse(error) {
  const status = error instanceof LogiccError && error.status >= 400 && error.status <= 599 ? error.status : 502;
  const message = error instanceof LogiccError ? error.message : "Logicc request failed.";
  return Response.json({ error: { message, type: status === 429 ? "rate_limit_error" :
    status === 401 ? "authentication_error" : "api_error", code: String(status) } }, {
    status, headers: { "Cache-Control": "no-store", ...(error?.retryAfter ? { "Retry-After": error.retryAfter } : {}),
      ...(error?.signIn === "expired" ? { "X-Magpie-Sign-In": "expired" } : {}) },
  });
}

export async function openAIResponse(body, req, onCancel = () => {}) {
  const id = "chatcmpl-" + crypto.randomUUID().replaceAll("-", "");
  const created = Math.floor(Date.now() / 1000);
  const base = { id, created, model: req.model };
  if (!req.stream) {
    const message = { role: "assistant", content: "" };
    const calls = [];
    let finish = "stop", usage;
    for await (const part of parts(body, req)) {
      if (part.content) message.content += part.content;
      if (part.reasoning_content) message.reasoning_content = (message.reasoning_content ?? "") + part.reasoning_content;
      for (const call of part.tool_calls ?? []) {
        if (call.id) calls[call.index] = { id: call.id, type: call.type, function: { ...call.function } };
        else calls[call.index].function.arguments += call.function.arguments;
      }
      if (part.finish) { finish = part.finish; usage = part.usage; }
    }
    if (calls.length) {
      message.tool_calls = calls;
      if (!message.content) message.content = null;
    }
    return Response.json({ ...base, object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) },
      { headers: { "Cache-Control": "no-store" } });
  }
  const encoder = new TextEncoder();
  const frame = payload => encoder.encode("data: " + JSON.stringify(payload) + "\n\n");
  const chunk = (delta, finish_reason = null) => frame({ ...base, object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason }] });
  async function* generate() {
    try {
      yield chunk({ role: "assistant" });
      for await (const part of parts(body, req)) {
        if (part.finish) {
          yield chunk({}, part.finish);
          if (req.includeUsage && part.usage) yield frame({ ...base, object: "chat.completion.chunk", choices: [], usage: part.usage });
        } else yield chunk(part);
      }
      yield encoder.encode("data: [DONE]\n\n");
    } catch (error) {
      yield frame({ error: { message: error instanceof LogiccError ? error.message : "Logicc stream failed.",
        type: "api_error", code: "upstream_stream_error" } });
      yield encoder.encode("data: [DONE]\n\n");
    } finally {
      if (!body.locked) await body.cancel().catch(() => {});
    }
  }
  const iterator = generate();
  return new Response(new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() { onCancel(); await iterator.return(); if (!body.locked) await body.cancel().catch(() => {}); },
  }), { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    "X-Accel-Buffering": "no",
  } });
}
