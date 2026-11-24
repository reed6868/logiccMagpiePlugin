import { test, expect } from "bun:test";
import * as entry from "../index.mjs";
import { createPlugin } from "../src/plugin.mjs";
import { API } from "../src/auth.mjs";
import { modelLimit } from "../src/models.mjs";

const sid = "sess_fixture";
const exp = Math.floor(Date.now() / 1000) + 120;
const jwt = "e30." + Buffer.from(JSON.stringify({ sid, exp, sub: "user_fixture" })).toString("base64url") + ".fixture";
const auth = { type: "oauth", access: jwt, refresh: "fixture-cookie", expires: exp * 1000, metadata: { sessionId: sid } };
const catalogue = [{ id: "fixture-model", name: "Fixture Model", isDefault: true, contextWindow: 16000, maxOutputTokens: 2000 }];
const sse = () => new Response('data: {"type":"text-delta","delta":"hello"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { headers: { "Content-Type": "text/event-stream" } });

test("single exported plugin and config preserves user-defined provider", async () => {
  expect(Object.keys(entry)).toEqual(["default"]);
  const plugin = await entry.default({});
  const cfg = {};
  await plugin.config(cfg);
  expect(cfg.provider.logicc.npm).toBe("@ai-sdk/openai-compatible");
  const existing = { provider: { logicc: { name: "Custom" } } };
  await plugin.config(existing);
  expect(existing.provider.logicc).toEqual({ name: "Custom" });
});

test("manual login masks the credential and validates without overwriting host auth", async () => {
  let writes = 0;
  const plugin = createPlugin({
    client: { auth: { set: async () => { writes++; } } },
    fetchImpl: async url => {
      if (url.endsWith("/tokens")) return Response.json({ jwt });
      if (url.endsWith("/v1/client")) return Response.json({ response: { sessions: [{ id: sid, status: "active" }] } });
      if (url.endsWith("/models?language=en")) return Response.json(catalogue);
      throw new Error("Unexpected endpoint");
    },
  });
  expect(plugin.auth.methods).toHaveLength(1);
  expect(plugin.auth.methods[0].prompts[0].type).toBe("password");
  const manual = await plugin.auth.methods[0].authorize({ cookie: "Cookie: theme=dark; __client=fixture-cookie", sid: "" });
  const result = await manual.callback();
  expect(result.type).toBe("success");
  expect(result.metadata.sessionId).toBe(sid);
  expect(result.metadata.defaultModelId).toBe("fixture-model");
  expect(writes).toBe(0);
});

test("model discovery uses account list, falls back on 429, propagates expiry", async () => {
  const provider = { models: { default: { name: "Fallback" } } };
  let status = 200;
  const plugin = createPlugin({ fetchImpl: async url => {
    if (url.endsWith("/tokens")) return Response.json({}, { status: 401 });
    return Response.json(status === 200 ? { models: catalogue } : {}, { status });
  } });
  const models = await plugin.provider.models(provider, { auth });
  expect(models["fixture-model"].limit).toEqual({ context: 16000, output: 2000 });
  expect(models["fixture-model"].capabilities.toolcall).toBe(true);
  status = 429;
  expect(await plugin.provider.models(provider, { auth })).toEqual(models);
  status = 401;
  await expect(plugin.provider.models(provider, { auth })).rejects.toMatchObject({ signIn: "expired" });
});

test("custom fetch creates chat and streams AI SDK v6; 429 propagates; unknown paths rejected", async () => {
  let called = [], status = 200;
  const plugin = createPlugin({ fetchImpl: async (url, init) => {
    called.push(url);
    expect(init.redirect).toBe("error");
    expect(init.headers.Authorization).toBe("Bearer " + jwt);
    if (status !== 200) return Response.json({}, { status, headers: { "Retry-After": "10" } });
    if (url.endsWith("/models?language=en")) return Response.json(catalogue);
    if (url.endsWith("/chats")) return Response.json({ id: "fixture-chat" });
    if (url.endsWith("/chats/fixture-chat")) {
      expect(init.headers["Stream-Response-Protocol"]).toBe("ai-sdk-v6");
      expect(JSON.parse(init.body)).toMatchObject({ modelId: "fixture-model", prompt: "ping", isVoicePrompt: false });
      return sse();
    }
    throw new Error("Unknown endpoint");
  } });
  const loader = await plugin.auth.loader(async () => auth);
  const request = { method: "POST", body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "ping" }], stream: true }) };
  const res = await loader.fetch(API + "/chat/completions", request);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('"content":"hello"');
  expect(called.length).toBe(3);
  status = 429;
  const limited = await loader.fetch(API + "/chat/completions", request);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("10");
  const count = called.length;
  expect((await loader.fetch("https://invalid.example/api/chat/completions", request)).status).toBe(400);
  expect(called.length).toBe(count);
});

test("repeated unauthorized response gives explicit 401 and sign-in state", async () => {
  let current = auth, calls = 0;
  const plugin = createPlugin({
    client: { auth: { set: async ({ body }) => { current = body; } } },
    fetchImpl: async url => {
      if (url.endsWith("/tokens")) return Response.json({ jwt });
      calls++;
      return Response.json({ confidential: "not echoed" }, { status: 401 });
    },
  });
  const loader = await plugin.auth.loader(async () => current);
  const res = await loader.fetch(API + "/chat/completions", { method: "POST", body: JSON.stringify({
    model: "fixture-model", messages: [{ role: "user", content: "ping" }], stream: true,
  }) });
  expect(res.status).toBe(401);
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired");
  expect(await res.text()).not.toContain("not echoed");
  expect(calls).toBe(2);
});

test("login cannot report success until the catalogue accepts the session JWT", async () => {
  let writes = 0;
  const plugin = createPlugin({
    client: { auth: { set: async () => { writes++; } } },
    fetchImpl: async (url, init) => {
      if (url.endsWith("/tokens")) return Response.json({ jwt });
      expect(init.headers.Authorization).toBe("Bearer " + jwt);
      return Response.json({ confidential: "not echoed" }, { status: 403 });
    },
  });
  const flow = await plugin.auth.methods[0].authorize({ cookie: "fixture-cookie", sid });
  const result = await flow.callback();
  expect(result.type).toBe("failed");
  expect(result.error).not.toContain("not echoed");
  expect(result.access).toBeUndefined();
  expect(writes).toBe(0);
});

test("upstream limit beats exact host metadata, then family estimates; unknown models only use the fallback", () => {
  const opus = { id: "claude-opus-5-5", name: "Claude 5.5 Opus" };
  const estimate = modelLimit(opus);
  expect(estimate.context).toBeGreaterThan(32_768);
  expect(estimate.output).toBeGreaterThan(4_096);
  expect(modelLimit({ ...opus, context: 300_000 }, { limit: { context: 400_000, output: 64_000 } }))
    .toEqual({ context: 300_000, output: 64_000 });
  for (const model of [
    { id: "gpt_5_5", name: "GPT 5.5" },
    { id: "gemini-3-pro", name: "Gemini Pro" },
    { id: "deepseek-v4", name: "DeepSeek V4" },
  ]) {
    expect(modelLimit(model).context).toBeGreaterThan(32_768);
    expect(modelLimit(model).output).toBeGreaterThan(4_096);
  }
  expect(modelLimit({ id: "unrecognized", name: "Opaque" })).toEqual({ context: 32_768, output: 4_096 });
});

test("default alias keeps its selected ID through reordering, changed default and temporary catalogue failure", async () => {
  const a = { id: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: true };
  const b = { id: "gpt-5-5", name: "GPT 5.5" };
  let models = [a, b], listStatus = 200;
  const selected = [];
  const plugin = createPlugin({ fetchImpl: async (url, init) => {
    if (url.endsWith("/models?language=en")) return Response.json(models, { status: listStatus });
    if (url.endsWith("/chats")) return Response.json({ id: "fixture-chat" });
    if (url.endsWith("/chats/fixture-chat")) {
      selected.push(JSON.parse(init.body).modelId);
      return sse();
    }
    throw new Error("Unexpected endpoint");
  } });
  const provider = { models: { default: { name: "Fallback" } } };
  const loader = await plugin.auth.loader(async () => auth);
  const request = { method: "POST", body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "ping" }], stream: true }) };
  const call = () => loader.fetch(API + "/chat/completions", request);
  const first = await plugin.provider.models(provider, { auth });
  expect(first.default.name).toContain(a.name);
  expect(first.default.limit).toEqual(first[a.id].limit);
  expect(first[a.id].limit.context).toBeGreaterThan(32_768);
  expect((await call()).status).toBe(200);
  models = [{ ...b, isDefault: true }, { ...a, isDefault: false }];
  expect((await call()).status).toBe(200);
  listStatus = 503;
  const cached = await plugin.provider.models(provider, { auth });
  expect(cached.default.name).toContain(a.name);
  expect((await call()).status).toBe(200);
  expect(selected).toEqual([a.id, a.id, a.id]);
  listStatus = 200;
  models = [b];
  const removed = await call();
  expect(removed.status).toBe(409);
  expect(selected).toHaveLength(3);
});

test("a persisted alias survives a new host and cache snapshots cannot cross accounts", async () => {
  const a = { id: "model-a", name: "Model A" }, b = { id: "model-b", name: "Model B", isDefault: true };
  const pinned = { ...auth, metadata: { ...auth.metadata, defaultModelId: a.id } };
  const sid2 = "sess_other_account";
  const jwt2 = "e30." + Buffer.from(JSON.stringify({ sid: sid2, exp, sub: "user_other" })).toString("base64url") + ".fixture";
  const other = { ...auth, access: jwt2, metadata: { sessionId: sid2 } };
  const plugin = createPlugin({ fetchImpl: async (url, init) => {
    expect(url).toEndWith("/models?language=en");
    if (init.headers.Authorization === "Bearer " + jwt2) return Response.json({}, { status: 503 });
    return Response.json([b, a]);
  } });
  const provider = { models: { default: { name: "Fallback" } } };
  expect((await plugin.provider.models(provider, { auth: pinned })).default.name).toContain(a.name);
  expect(await plugin.provider.models(provider, { auth: other })).toBe(provider.models);
});

test("agent request accepts mixed tools and media at the actual loader boundary", async () => {
  let forwarded;
  const plugin = createPlugin({ fetchImpl: async (url, init) => {
    if (url.endsWith("/chats")) return Response.json({ id: "fixture-chat" });
    if (url.endsWith("/chats/fixture-chat")) { forwarded = JSON.parse(init.body); return sse(); }
    throw new Error("Unexpected endpoint");
  } });
  const loader = await plugin.auth.loader(async () => auth);
  const result = await loader.fetch(API + "/chat/completions", { method: "POST", body: JSON.stringify({
    model: "fixture-model", stream: true, max_tokens: 32,
    messages: [{ role: "user", content: [
      { type: "text", text: "Explain the code" },
      { type: "image_url", image_url: { url: "data:image/png;base64," + "a".repeat(2 * 1024 * 1024) } },
    ] }],
    tools: [{ type: "web_search" }, { type: "function", function: { name: "echo_value", parameters: { type: "object" } } }],
  }) });
  expect(result.status).toBe(200);
  expect(await result.text()).toContain('"content":"hello"');
  expect(forwarded.prompt).toContain("[unsupported image omitted]");
  expect(forwarded.prompt).toContain("echo_value");
  expect(forwarded.prompt).not.toContain("web_search");
  expect(forwarded.prompt).not.toContain("data:image");
  expect(forwarded.prompt).not.toContain("output tokens");
  expect(Object.hasOwn(forwarded, "max_tokens")).toBe(false);
});
