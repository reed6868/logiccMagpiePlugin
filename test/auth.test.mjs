import { test, expect } from "bun:test";
import { refreshAuth, createAuthManager, apiRequest, isFresh, parseClientCredential, chooseActiveSession } from "../src/auth.mjs";

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

test("explicit credential import accepts a single value or a Cookie header without other credentials", () => {
  expect(parseClientCredential("fixture-cookie")).toBe("fixture-cookie");
  expect(parseClientCredential("__client=fixture-cookie")).toBe("fixture-cookie");
  expect(parseClientCredential("Cookie: other=private; __client=fixture-cookie; theme=dark")).toBe("fixture-cookie");
  expect(parseClientCredential("Cookie: __client=one; __client=two")).toBeUndefined();
  expect(parseClientCredential("Cookie: theme=dark")).toBeUndefined();
  expect(parseClientCredential("Cookie: __client=one\r\nX-Test: two")).toBeUndefined();
});

test("multiple active sessions prefer last active ID, then recency; manual SID overrides discovery", async () => {
  const sessions = [
    { id: sid, status: "active", last_active_at: 1700000000000 },
    { id: "sess_other", status: "active", last_active_at: 1700000100 },
    { id: "sess_ended", status: "ended", updated_at: 1800000000000 },
  ];
  expect(chooseActiveSession({ sessions, last_active_session_id: sid })).toBe(sid);
  expect(chooseActiveSession({ sessions, last_active_session_id: "sess_ended" })).toBe("sess_other");
  expect(chooseActiveSession({ sessions: [
    { id: sid, status: "active", updated_at: "2025-01-01T00:00:00Z" },
    { id: "sess_other", status: "active", updated_at: "2025-02-01T00:00:00Z" },
  ] })).toBe("sess_other");
  expect(chooseActiveSession({ sessions: [{ id: "sess_b", status: "active" }, { id: "sess_a", status: "active" }] })).toBe("sess_a");
  const credential = parseClientCredential("Cookie: theme=dark; __client=fixture-cookie");
  for (const manual of [undefined, sid]) {
    let discovered = 0;
    const expected = manual ?? "sess_other";
    const result = await refreshAuth({ refresh: credential, metadata: manual ? { sessionId: manual } : {} }, {
      fetchImpl: async (url, init) => {
        expect(init.headers.Cookie).toBe("__client=fixture-cookie");
        if (url.endsWith("/v1/client")) { discovered++; return json({ response: { sessions } }); }
        expect(url).toEndWith("/" + expected + "/tokens");
        return json({ jwt: jwt(expected) });
      },
    });
    expect(result.metadata.sessionId).toBe(expected);
    expect(discovered).toBe(manual ? 0 : 1);
  }
  await expect(refreshAuth({ refresh: credential }, { fetchImpl: async () => json({ response: { sessions: [] } }) }))
    .rejects.toMatchObject({ signIn: "expired" });
});

test("removed device OAuth accounts must sign in again; their tokens never reach inference", async () => {
  const obsolete = { ...auth(), metadata: { oauthGrant: "device", sessionId: sid } };
  const manager = createAuthManager(undefined, async () => { throw new Error("must not fetch"); });
  expect(isFresh(obsolete)).toBe(false);
  await expect(manager.renew(obsolete)).rejects.toMatchObject({ signIn: "expired" });
  await expect(manager.ensure(async () => obsolete)).rejects.toMatchObject({ signIn: "expired" });
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

test("host refresh joins a loader refresh that is still being persisted", async () => {
  const initial = auth(jwt(sid, Math.floor(Date.now() / 1000) - 1));
  let current = initial, refreshes = 0, writes = 0;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const manager = createAuthManager({ auth: { set: async ({ body }) => {
    writes++;
    started.resolve();
    await release.promise;
    current = body;
  } } }, async () => {
    refreshes++;
    return json({ jwt: jwt() }, 200, { "Set-Cookie": "__client=fixture-rotated; Secure" });
  });
  const loader = manager.ensure(async () => current);
  await started.promise;
  const host = manager.renew(initial);
  try {
    await Bun.sleep(5);
    expect(refreshes).toBe(1);
    expect(writes).toBe(1);
  } finally { release.resolve(); }
  const [a, b] = await Promise.all([loader, host]);
  expect(a).toEqual(b);
  expect(current.refresh).toBe("fixture-rotated");
});

test("late loader renewal does not overwrite a newer sign-in or restore a logged-out account", async () => {
  const initial = auth(jwt(sid, Math.floor(Date.now() / 1000) - 1));
  for (const replacement of [null, auth(jwt(sid, Math.floor(Date.now() / 1000) + 300), "new-authorized-fixture")]) {
    let current = initial, writes = 0;
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const manager = createAuthManager({ auth: { set: async () => { writes++; } } }, async () => {
      started.resolve();
      await release.promise;
      return json({ jwt: jwt() });
    });
    const operation = manager.ensure(async () => current);
    await started.promise;
    current = replacement;
    release.resolve();
    if (replacement) expect(await operation).toEqual(replacement);
    else await expect(operation).rejects.toMatchObject({ signIn: "expired" });
    expect(writes).toBe(0);
  }
});

test("refresh rejects a different JWT subject even if the session ID matches", async () => {
  await expect(refreshAuth(auth(), { fetchImpl: async () =>
    json({ jwt: jwt(sid, Math.floor(Date.now() / 1000) + 120, "user_other") }),
  })).rejects.toMatchObject({ signIn: "expired" });
});

test("cancelled authentication does not start an upstream request", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await expect(refreshAuth(auth(), { signal: controller.signal, fetchImpl: async () => {
    calls++;
    return json({ jwt: jwt() });
  } })).rejects.toMatchObject({ status: 504 });
  expect(calls).toBe(0);
});

test("cancellation after a rotation retains the new credential only for an existing account", async () => {
  const controller = new AbortController();
  let saved;
  await expect(refreshAuth(auth(), {
    signal: controller.signal,
    fetchImpl: async () => {
      controller.abort();
      return json({ jwt: jwt() }, 200, { "Set-Cookie": "__client=fixture-rotated; Secure" });
    },
    persistRotation: async value => { saved = value; },
  })).rejects.toMatchObject({ status: 504 });
  expect(saved.refresh).toBe("fixture-rotated");
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
