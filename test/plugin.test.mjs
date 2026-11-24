import { test, expect } from "bun:test";
import * as entry from "../index.mjs";
import { createPlugin } from "../src/plugin.mjs";
import { API } from "../src/auth.mjs";

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
  expect(plugin.auth.methods[1].prompts[0].type).toBe("password");
  const manual = await plugin.auth.methods[1].authorize({ cookie: "fixture-cookie", sid: "" });
  const result = await manual.callback();
  expect(result.type).toBe("success");
  expect(result.metadata.sessionId).toBe(sid);
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
  expect(await plugin.provider.models(provider, { auth })).toBe(provider.models);
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
