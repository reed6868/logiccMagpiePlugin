import { test, expect } from "bun:test";
import { beginDeviceAuthorization, completeDeviceAuthorization, createAuthManager, DEVICE_GRANT, isFresh } from "../src/auth.mjs";
import { createPlugin } from "../src/plugin.mjs";

const clerk = "https://clerk.logicc.com";
const clientId = "fixture-approved-client";
const metadata = {
  issuer: clerk,
  device_authorization_endpoint: clerk + "/oauth/device_authorization",
  token_endpoint: clerk + "/oauth/token",
  userinfo_endpoint: clerk + "/oauth/userinfo",
  grant_types_supported: [DEVICE_GRANT, "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["openid", "offline_access"],
};
const device = {
  verification_uri: "https://accounts.logicc.com/device",
  device_code: "fixture-device-secret",
  user_code: "ABCD-EFGH",
  interval: 5,
  expires_in: 600,
};
const tokens = { token_type: "Bearer", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 };
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const skipWait = async () => {};

function makeFetch({ start = device, discovery = metadata, poll = [tokens], modelStatus = 200, identity = { sub: "fixture-user" } } = {}) {
  const calls = [];
  let polled = 0;
  const fetchImpl = async (url, init) => {
    expect(init.redirect).toBe("error");
    const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : undefined;
    calls.push({ url, form });
    expect(init.headers.Cookie).toBeUndefined();
    if (url.endsWith("/.well-known/openid-configuration")) return json(discovery);
    if (url.endsWith("/oauth/device_authorization")) {
      expect(form).toEqual({ client_id: clientId, scope: "openid offline_access" });
      return json(start, start.error ? 400 : 200);
    }
    if (url.endsWith("/oauth/token")) {
      expect(form).toEqual({ client_id: clientId, device_code: device.device_code, grant_type: DEVICE_GRANT });
      const next = poll[polled++];
      if (!next) throw new Error("Unexpected poll");
      return json(next, next.error ? 400 : 200);
    }
    if (url.endsWith("/oauth/userinfo")) {
      expect(init.headers.Authorization).toBe("Bearer " + tokens.access_token);
      return json(identity);
    }
    if (url.endsWith("/models?language=en")) {
      expect(init.headers.Authorization).toBe("Bearer " + tokens.access_token);
      return json(modelStatus === 200 ? [{ id: "fixture-model" }] : {}, modelStatus);
    }
    throw new Error("Unexpected URL");
  };
  return { calls, fetchImpl };
}

test("device grant uses the documented system-browser hook and never exposes its device secret", async () => {
  const { fetchImpl, calls } = makeFetch();
  let writes = 0;
  const plugin = createPlugin({ fetchImpl, deviceWait: skipWait,
    client: { auth: { set: async () => { writes++; } } } });
  const method = plugin.auth.methods[0];
  expect(method.type).toBe("oauth");
  expect(method.prompts[0].key).toBe("clientId");
  const step = await method.authorize({ clientId });
  expect(step.url).toBe(device.verification_uri);
  expect(step.method).toBe("auto");
  expect(step.instructions).toContain(device.user_code);
  expect(JSON.stringify(step)).not.toContain(device.device_code);
  const result = await step.callback();
  expect(result.type).toBe("success");
  expect(result.metadata).toEqual({ oauthGrant: "device", clientId });
  expect(result.accountId).toMatch(/^Logicc OAuth [a-f0-9]{24}$/);
  expect(result.access).toBe(tokens.access_token);
  expect(result.refresh).toBe(tokens.refresh_token);
  expect(isFresh({ ...result, type: "oauth" })).toBe(true);
  expect(writes).toBe(0);
  expect(calls.length).toBe(5);
});

test("pending authorization and slow_down respect increasing polling intervals", async () => {
  const { fetchImpl } = makeFetch({ poll: [
    { error: "authorization_pending" }, { error: "slow_down" }, tokens,
  ] });
  const step = await beginDeviceAuthorization(clientId, { fetchImpl });
  const waits = [];
  const result = await completeDeviceAuthorization(step, { fetchImpl, wait: async ms => { waits.push(ms); } });
  expect(waits).toEqual([5000, 5000, 10000]);
  expect(result.access).toBe(tokens.access_token);
});

test("missing/unauthorized client, changed metadata, or untrusted browser URL fail closed", async () => {
  let attempted = false;
  const plugin = createPlugin({ fetchImpl: async () => { attempted = true; throw new Error("not allowed"); } });
  const missing = await plugin.auth.methods[0].authorize({});
  expect(missing.type).toBe("failed");
  expect(missing.error).toContain("client ID");
  expect(attempted).toBe(false);
  for (const config of [
    { start: { error: "invalid_client", error_description: "secret upstream diagnostic" } },
    { start: { ...device, verification_uri: "https://logicc.com.attacker.example/device" } },
    { discovery: { ...metadata, token_endpoint: "https://other.example/token" } },
    { discovery: { ...metadata, grant_types_supported: [] } },
  ]) {
    const { fetchImpl, calls } = makeFetch(config);
    const denied = await createPlugin({ fetchImpl }).auth.methods[0].authorize({ clientId });
    expect(denied.type).toBe("failed");
    expect(denied.error).not.toContain("secret upstream diagnostic");
    expect(denied.callback).toBeUndefined();
    expect(calls.every(c => c.url.startsWith(clerk + "/"))).toBe(true);
  }
});

test("cancelled or denied device authorization never saves an account", async () => {
  for (const error of ["access_denied", "expired_token"]) {
    const { fetchImpl, calls } = makeFetch({ poll: [{ error }] });
    const plugin = createPlugin({ fetchImpl, deviceWait: skipWait });
    const step = await plugin.auth.methods[0].authorize({ clientId });
    const result = await step.callback();
    expect(result.type).toBe("failed");
    expect(calls.some(c => c.url.endsWith("/oauth/userinfo"))).toBe(false);
  }
  const { fetchImpl, calls } = makeFetch();
  const step = await createPlugin({ fetchImpl, deviceWait: skipWait }).auth.methods[0].authorize({ clientId });
  const cancelled = await step.callback(undefined, { signal: AbortSignal.abort() });
  expect(cancelled.type).toBe("failed");
  expect(cancelled.error).toContain("cancelled");
  expect(calls.length).toBe(2);
});

test("OAuth consent is not accepted as inference permission; 401 and 403 fail before account storage", async () => {
  for (const status of [401, 403]) {
    const { fetchImpl, calls } = makeFetch({ modelStatus: status });
    let writes = 0;
    const plugin = createPlugin({ fetchImpl, deviceWait: skipWait, client: { auth: { set: async () => { writes++; } } } });
    const step = await plugin.auth.methods[0].authorize({ clientId });
    const result = await step.callback();
    expect(result.type).toBe("failed");
    expect(result.error).toContain("model access was refused");
    expect(result.access).toBeUndefined();
    expect(writes).toBe(0);
    expect(calls.filter(c => c.url.endsWith("/oauth/token")).length).toBe(1);
  }
});

test("OAuth refresh uses refresh_token grant, rotates once and persists per account", async () => {
  const { fetchImpl } = makeFetch();
  const original = await completeDeviceAuthorization(await beginDeviceAuthorization(clientId, { fetchImpl }), { fetchImpl, wait: skipWait });
  let current = { ...original, type: "oauth", expires: Date.now() - 1 };
  let calls = 0, writes = 0;
  const manager = createAuthManager({ auth: { set: async ({ path, body }) => {
    expect(path.id).toBe("logicc");
    writes++;
    current = body;
  } } }, async (url, init) => {
    calls++;
    await Bun.sleep(5);
    expect(url).toBe(clerk + "/oauth/token");
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token,
    });
    expect(init.headers.Cookie).toBeUndefined();
    return json({ ...tokens, access_token: "fixture-next-access", refresh_token: "fixture-next-refresh" });
  });
  const results = await Promise.all(Array.from({ length: 6 }, () => manager.ensure(async () => current)));
  expect(calls).toBe(1);
  expect(writes).toBe(1);
  expect(current.access).toBe("fixture-next-access");
  expect(current.refresh).toBe("fixture-next-refresh");
  expect(current.accountId).toBe(original.accountId);
  expect(results.every(isFresh)).toBe(true);
});

test("revoked OAuth grant is expired; rate-limit response is preserved", async () => {
  const auth = { type: "oauth", access: tokens.access_token, refresh: tokens.refresh_token,
    expires: Date.now() - 1, accountId: "Logicc OAuth " + "a".repeat(24),
    metadata: { oauthGrant: "device", clientId } };
  const revoked = createAuthManager(undefined, async () => json({ error: "invalid_grant" }, 400));
  await expect(revoked.renew(auth)).rejects.toMatchObject({ signIn: "expired" });
  const limited = createAuthManager(undefined, async () => new Response("limited", { status: 429, headers: { "Retry-After": "12" } }));
  try {
    await limited.renew(auth);
    throw new Error("Expected rate limit");
  } catch (error) {
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe("12");
    expect(error.signIn).toBeUndefined();
  }
});
