// Optional live gateway smoke test. Never prints credentials or account tokens.
// Run only after the user has signed in to an authorized Logicc account.
const model = process.argv[2];
if (!model?.startsWith("logicc/")) throw new Error("Usage: bun scripts/e2e.mjs logicc/<model>");
const base = process.env.MAGPIE_URL || "http://127.0.0.1:3425";
const token = process.env.MAGPIE_API_KEY || "magpie";
const endpoint = new URL("/v1/chat/completions", base);
if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("E2E only supports a local gateway.");
const decoder = new TextDecoder();
async function run(label, body) {
  const start = performance.now();
  const response = await fetch(endpoint, { method: "POST", redirect: "error",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true, ...body }),
    signal: AbortSignal.timeout(180_000) });
  let pending = "", text = "", reasoning = "", calls = {}, finish, firstText, firstDelta, streamError = false, done = false;
  if (!response.ok) {
    await response.body?.cancel();
    console.log(JSON.stringify({ label, status: response.status, error: "Gateway rejected request", durationMs: Math.round(performance.now() - start) }));
    return false;
  }
  for await (const bytes of response.body) {
    pending += decoder.decode(bytes, { stream: true });
    let end;
    while ((end = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, end.index);
      pending = pending.slice(end.index + end[0].length);
      const data = frame.split(/\r?\n/).filter(x => x.startsWith("data:")).map(x => x.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { done = true; continue; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { streamError = true; continue; }
      if (chunk.error) { streamError = true; continue; }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        if (delta.content || delta.reasoning_content || delta.tool_calls?.length) firstDelta ??= Math.round(performance.now() - start);
        if (delta.content) { firstText ??= Math.round(performance.now() - start); text += delta.content; }
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        for (const call of delta.tool_calls ?? []) {
          const out = calls[call.index ?? 0] ??= { id: "", name: "", arguments: "" };
          if (call.id) out.id = call.id;
          if (call.function?.name) out.name += call.function.name;
          if (call.function?.arguments) out.arguments += call.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
  }
  const result = { label, status: response.status, firstDeltaMs: firstDelta ?? null, firstTextMs: firstText ?? null,
    durationMs: Math.round(performance.now() - start), text, reasoning, toolCalls: Object.values(calls), finish, done, streamError };
  console.log(JSON.stringify(result, null, 2));
  if (label === "tools") {
    try {
      const call = Object.values(calls)[0];
      return !streamError && done && finish === "tool_calls" && call?.name === "echo_value" &&
        JSON.parse(call.arguments).value === "logicc-e2e";
    } catch { return false; }
  }
  return !streamError && done && Boolean(text) && finish === "stop";
}
const normal = await run("stream", { messages: [{ role: "user", content: "Reply with exactly: Logicc E2E OK" }] });
const tools = await run("tools", { messages: [{ role: "user", content: 'Call echo_value with value "logicc-e2e". Do not answer in text.' }],
  tools: [{ type: "function", function: { name: "echo_value", description: "Echo the supplied value",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } }],
  tool_choice: { type: "function", function: { name: "echo_value" } }, parallel_tool_calls: false });
process.exitCode = normal && tools ? 0 : 1;
