import { test, expect } from "bun:test";
import { refreshAuth, createAuthManager, apiRequest, isFresh } from "../src/auth.mjs";

const sid = "sess_fixture_one";
const jwt = (session = sid, exp = Math.floor(Date.now() / 1000) + 120, sub = "user_fixture") =>
  "e30." + Buffer.from(JSON.stringify({ sid: session, exp, sub })).toString("base64url") + ".fixture";
const auth = (access = jwt(), refresh = "fixture-cookie") => ({
  type: "oauth", access, refresh, expires: JSON.parse(Buffer.from(access.split(".")[1], "base64url")).exp * 1000,
  metadata: { sessionId: sid, retained: true },
});
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });

test("Clerk refresh rotates __client and preserves metadata and expiry", async () => {
  const access = jwt();
  const result = await refreshAuth(auth(), { fetchImpl: async (url, init) => {
    expect(url).toBe("https://clerk.logicc.com/v1/client/sessions/" + sid + "/tokens");
    expect(init.method).toBe("POST");
    expect(init.headers.Cookie).toBe("__client=fixture-cookie");
    expect(init.redirect).toBe("error");
    return json({ jwt: access }, 200, { "Set-Cookie": "__client=fixture-rotated; Path=/; Secure; HttpOnly" });
  } });
  expect(result.access).toBe(access);
  expect(result.refresh).toBe("fixture-rotated");
  expect(result.expires).toBe(auth(access).expires);
  expect(result.metadata).toEqual({ sessionId: sid, retained: true });
  expect(result.accountId).not.toContain(sid);
});

test("optional session discovery selects the active session and carries rotation", async () => {
  const result = await refreshAuth({ refresh: "fixture-cookie", metadata: {} }, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/v1/client")) {
        expect(init.method).toBe("GET");
        return json({ response: { sessions: [{ id: sid, status: "active" }, { id: "sess_other", status: "ended" }] } }, 200,
          { "Set-Cookie": "__client=fixture-discovered; HttpOnly" });
      }
      expect(init.headers.Cookie).toBe("__client=fixture-discovered");
      return json({ jwt: jwt() });
    },
  });
  expect(result.metadata.sessionId).toBe(sid);
  expect(result.refresh).toBe("fixture-discovered");
});

test("ambiguous sessions are not guessed", async () => {
  await expect(refreshAuth({ refresh: "fixture-cookie" }, {
    fetchImpl: async () => json({ response: { sessions: [{ id: sid, status: "active" }, { id: "sess_other", status: "active" }] } }),
  })).rejects.toMatchObject({ signIn: "expired" });
});

test("invalid sid, invalid cookie, mismatched JWT and revoked login fail closed", async () => {
  for (const input of [
    { refresh: "bad\r\nCookie: unsafe", metadata: { sessionId: sid } },
    { refresh: "fixture-cookie", metadata: { sessionId: "../other" } },
  ]) {
    await expect(refreshAuth(input, { fetchImpl: async () => { throw new Error("must not fetch"); } })).rejects.toMatchObject({ signIn: "expired" });
  }
  await expect(refreshAuth(auth(), { fetchImpl: async () => json({ jwt: jwt("sess_other") }) })).rejects.toMatchObject({ signIn: "expired" });
  for (const status of [401, 403]) {
    await expect(refreshAuth(auth(), { fetchImpl: async () => json({ secret: "must never be echoed" }, status) })).rejects.toMatchObject({ status, signIn: "expired" });
  }
});

test("429 is not sign-in expiry; a rotated cookie on transient failure is saved", async () => {
  let saved;
  try {
    await refreshAuth(auth(), {
      fetchImpl: async () => json({}, 429, { "Retry-After": "30", "Set-Cookie": "__client=fixture-next; Secure" }),
      persistRotation: async x => { saved = x; },
    });
    throw new Error("Expected rate limit");
  } catch (e) {
    expect(e.status).toBe(429);
    expect(e.signIn).toBeUndefined();
    expect(e.retryAfter).toBe("30");
    expect(saved.refresh).toBe("fixture-next");
    expect(saved.metadata.sessionId).toBe(sid);
  }
});

test("concurrent fallback refresh saves the complete account only once", async () => {
  let current = { ...auth(jwt(sid, Math.floor(Date.now() / 1000) - 1)), custom: "preserved" };
  let refreshes = 0, writes = 0;
  const manager = createAuthManager({ auth: { set: async ({ path, body }) => {
    expect(path.id).toBe("logicc");
    writes++;
    await Bun.sleep(10);
    current = body;
  } } }, async () => {
    refreshes++;
    await Bun.sleep(10);
    return json({ jwt: jwt() }, 200, { "Set-Cookie": "__client=fixture-rotated; Secure" });
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => manager.ensure(async () => current)));
  expect(refreshes).toBe(1);
  expect(writes).toBe(1);
  expect(current.refresh).toBe("fixture-rotated");
  expect(current.custom).toBe("preserved");
  expect(results.every(isFresh)).toBe(true);
});

test("API 401 triggers exactly one refresh and retry; 429 is not retried", async () => {
  let current = auth();
  let refreshes = 0, calls = 0;
  const next = jwt(sid, Math.floor(Date.now() / 1000) + 300);
  const fetchImpl = async (url, init) => {
    if (url.startsWith("https://clerk.logicc.com/")) {
      refreshes++;
      return json({ jwt: next }, 200, { "Set-Cookie": "__client=fixture-rotated; Secure" });
    }
    calls++;
    if (calls === 1) return json({}, 401);
    expect(init.headers.Authorization).toBe("Bearer " + next);
    if (calls === 2) return json({ id: "chat" });
    return json({}, 429, { "Retry-After": "5" });
  };
  const manager = createAuthManager({ auth: { set: async ({ body }) => { current = body; } } }, fetchImpl);
  expect(await (await apiRequest(manager, async () => current, fetchImpl, "chats", { body: {} })).json()).toEqual({ id: "chat" });
  expect(current.refresh).toBe("fixture-rotated");
  await expect(apiRequest(manager, async () => current, fetchImpl, "chats", { body: {} })).rejects.toMatchObject({ status: 429, retryAfter: "5" });
  expect(refreshes).toBe(1);
  expect(calls).toBe(3);
});

test("API forbidden model is not marked as expired sign-in", async () => {
  const manager = createAuthManager(undefined, async () => json({}, 403));
  try {
    await apiRequest(manager, async () => auth(), async () => json({}, 403), "chats", { body: {} });
    throw new Error("Expected forbidden response");
  } catch (error) {
    expect(error.status).toBe(403);
    expect(error.signIn).toBeUndefined();
  }
});
