// Adapted from logicc2api/protocols.mjs (MIT), Chat Completions only.
import { LogiccError } from "./auth.mjs";
const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = msg => { throw new LogiccError(400, msg); };
const badTool = msg => { throw new LogiccError(502, msg); };
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) invalid("Invalid message content.");
  return content.map(part => {
    if (["text", "input_text", "output_text"].includes(part?.type) && typeof part.text === "string") return part.text;
    if (["thinking", "redacted_thinking"].includes(part?.type)) return "";
    invalid("Logicc currently supports text-only messages.");
  }).join("\n");
}

function argsObject(value, fail) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { fail("Invalid tool arguments JSON."); }
  }
  if (!obj(value)) fail("Tool arguments must be a JSON object.");
  return value;
}

export function normalize(body) {
  if (!obj(body) || typeof body.model !== "string" || !body.model ||
      !Array.isArray(body.messages) || !body.messages.length) invalid("model and messages are required.");
  if (body.n !== undefined && body.n !== 1) invalid("Only n=1 is supported.");
  if (body.stream !== undefined && typeof body.stream !== "boolean") invalid("Invalid stream flag.");
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") invalid("Invalid parallel_tool_calls.");
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined && (!Number.isInteger(max) || max <= 0)) invalid("Invalid token limit.");
  const messages = [];
  const callIds = new Set(), results = new Set();
  for (const m of body.messages) {
    if (!obj(m) || !["system", "developer", "user", "assistant", "tool"].includes(m.role)) invalid("Invalid message role.");
    const item = { role: m.role, content: textOf(m.content) };
    if (m.tool_calls !== undefined) {
      if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) invalid("Invalid tool history.");
      item.tool_calls = m.tool_calls.map(c => {
        if (typeof c?.id !== "string" || !c.id || callIds.has(c.id) ||
            !TOOL_NAME.test(c.function?.name ?? "")) invalid("Invalid or duplicate tool call.");
        callIds.add(c.id);
        return { id: c.id, name: c.function.name, arguments: argsObject(c.function.arguments ?? {}, invalid) };
      });
    }
    if (m.role === "tool") {
      if (!callIds.has(m.tool_call_id) || results.has(m.tool_call_id)) invalid("Tool result must refer to one previous call.");
      results.add(m.tool_call_id);
      item.tool_call_id = m.tool_call_id;
    }
    messages.push(item);
  }
  if (!messages.some(m => m.content || m.tool_calls?.length)) invalid("Empty messages.");
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 128)) invalid("Invalid tools array.");
  const tools = (body.tools ?? []).map(t => {
    const fn = t?.function;
    if (t?.type !== "function" || !obj(fn) || !TOOL_NAME.test(fn.name ?? "") ||
        (fn.parameters !== undefined && !obj(fn.parameters))) invalid("Only valid function tools are supported.");
    return { name: fn.name, description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters ?? { type: "object", properties: {} } };
  });
  if (new Set(tools.map(t => t.name)).size !== tools.length) invalid("Duplicate tool names.");
  let choice = body.tool_choice ?? "auto";
  if (obj(choice)) choice = choice.type === "function" ? choice.function?.name : undefined;
  if (!["auto", "none", "required", ...tools.map(t => t.name)].includes(choice)) invalid("Invalid tool_choice.");
  const active = choice === "none" ? [] : tools.filter(t => ["auto", "required"].includes(choice) || t.name === choice);
  if (choice === "required" && !active.length) invalid("Required tool choice needs tools.");
  // Magpie supplies the API model ID, not its public provider/id name.
  const model = body.model;
  return { model, messages, active, choice, required: choice === "required" || active.some(t => t.name === choice),
    parallel: body.parallel_tool_calls !== false, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true,
    max, reasoning: body.reasoning_effort ?? body.reasoning?.effort };
}

export function buildPrompt(request) {
  const history = request.messages.map(m => {
    if (m.tool_calls?.length) return "[Assistant]\n" + m.content + "\n[Tool calls]\n" + JSON.stringify(m.tool_calls);
    if (m.role === "tool") return "[Tool result: " + m.tool_call_id + "]\n" + m.content;
    return m.role === "user" ? m.content : "[" + m.role + "]\n" + m.content;
  }).join("\n\n");
  const limit = request.max ? "\nKeep the response within approximately " + request.max + " output tokens." : "";
  if (!request.active.length) return history + limit;
  return [
    "Serialize the next assistant turn for a client application. Only the client executes declared functions; do not execute them or invent their results.",
    'Return exactly one JSON object without markdown: {"content": "text or null", "tool_calls": [{"name": "a declared tool", "arguments": {}}]}.',
    "Arguments must match the tool schema. If a tool is needed, request it and stop. Use previous tool results when available.",
    request.required ? "You MUST request " + (request.choice === "required" ? "at least one declared tool." : request.choice + ".") : "Choose a tool only when needed; otherwise answer in content with an empty tool_calls array.",
    "Parallel calls: " + (request.parallel ? "allowed" : "disabled; at most one call."),
    "Declared client tools:\n" + JSON.stringify(request.active),
    "Conversation:\n" + JSON.stringify(request.messages),
    "Return the next assistant turn JSON now." + limit,
  ].join("\n");
}

function schemaCheck(value, schema, depth = 0) {
  if (!obj(schema) || depth > 32) return;
  const types = schema.type ? [schema.type].flat() : [];
  const matches = type => type === "null" ? value === null : type === "array" ? Array.isArray(value) :
    type === "object" ? obj(value) : type === "integer" ? Number.isInteger(value) : typeof value === type;
  if (types.length && !types.some(matches)) badTool("Tool argument type does not match schema.");
  if (Array.isArray(schema.enum) && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) badTool("Tool argument is outside schema enum.");
  if (obj(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) if (!Object.hasOwn(value, key)) badTool("Tool argument missing required property.");
    for (const [key, child] of Object.entries(value)) {
      const property = obj(schema.properties) && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (schema.additionalProperties === false && property === undefined) badTool("Unknown tool argument property.");
      schemaCheck(child, property ?? schema.additionalProperties, depth + 1);
    }
  } else if (Array.isArray(value)) for (const child of value) schemaCheck(child, schema.items, depth + 1);
}

export function validateCalls(calls, request) {
  if (!Array.isArray(calls) || calls.length > 32 || (!request.parallel && calls.length > 1)) badTool("Invalid number of tool calls.");
  const ids = new Set();
  return calls.map(raw => {
    const name = raw?.function?.name ?? raw?.name;
    const tool = request.active.find(t => t.name === name);
    if (!tool) badTool("Model requested an undeclared tool.");
    const args = argsObject(raw.function?.arguments ?? raw.arguments ?? raw.input, badTool);
    schemaCheck(args, tool.parameters);
    const id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(raw.id) ? raw.id : "call_" + crypto.randomUUID().replaceAll("-", "");
    if (ids.has(id)) badTool("Duplicate output tool call ID.");
    ids.add(id);
    return { id,
      type: "function", function: { name, arguments: JSON.stringify(args) } };
  });
}

export function parseToolOutput(text, request, nativeCalls = []) {
  if (nativeCalls.length) return { text, calls: validateCalls(nativeCalls, request) };
  let value = text.trim();
  const fence = /^\x60\x60\x60(?:json)?\s*\n?([\s\S]*?)\n?\x60\x60\x60\s*$/i.exec(value);
  if (fence) value = fence[1].trim();
  let parsed;
  try { parsed = JSON.parse(value); } catch {}
  if (obj(parsed) && Object.hasOwn(parsed, "tool_calls")) {
    if (parsed.content != null && typeof parsed.content !== "string") badTool("Invalid tool envelope content.");
    const calls = validateCalls(Array.isArray(parsed.tool_calls) ? parsed.tool_calls.map(call =>
      obj(call) ? { ...call, id: undefined } : call) : parsed.tool_calls, request);
    if (request.required && !calls.length) badTool("Model did not request the required tool.");
    return { text: parsed.content ?? "", calls };
  }
  if (request.required) badTool("Model did not return a valid required tool call.");
  return { text, calls: [] };
}
