// Clerk sign-in adaptation from logicc2api/pool.mjs (MIT; see LICENSE).
import { createHash } from "node:crypto";
export const ID = "logicc";
export const APP = "https://app.logicc.com";
export const API = APP + "/api";
const CLERK = "https://clerk.logicc.com";
export const REFRESH_LEAD = 10_000;

export class LogiccError extends Error {
  constructor(status, message, { retryAfter, expired = false } = {}) {
    super(message);
    this.status = status;
    if (retryAfter) this.retryAfter = retryAfter;
    if (expired) this.signIn = "expired";
  }
}

export function expired(message = "Logicc sign-in expired; sign in again.") {
  return new LogiccError(401, message, { expired: true });
}

export function claims(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  } catch { return {}; }
}

export function validCookie(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 &&
    /^[^\s;,\x00-\x1f\x7f]+$/.test(value);
}

export function validSession(value) {
  return typeof value === "string" && /^sess_[A-Za-z0-9_-]{1,200}$/.test(value);
}

export function isFresh(auth, now = Date.now()) {
  const jwt = claims(auth?.access);
  const sid = auth?.metadata?.sessionId;
  return validSession(sid) && jwt.sid === sid && Number.isFinite(jwt.exp) &&
    jwt.exp * 1000 > now + REFRESH_LEAD &&
    Number.isFinite(auth?.expires) && auth.expires > now + REFRESH_LEAD;
}

function rotatedCookie(response, previous) {
  for (const line of response.headers.getSetCookie()) {
    const match = /^__client=([^;]+)/.exec(line);
    if (match && validCookie(match[1]) && !/;\s*max-age=0(?:;|$)/i.test(line)) {
      previous = match[1];
    }
  }
  return previous;
}

function retryAfter(headers) {
  const value = headers.get("retry-after");
  return value && (/^\d{1,10}$/.test(value) || Number.isFinite(Date.parse(value))) ? value : undefined;
}

export function httpError(response, label, { signIn = false } = {}) {
  const status = response.status;
  return new LogiccError(status, label + " failed (HTTP " + status + ").", {
    expired: signIn && (status === 401 || status === 403),
    retryAfter: retryAfter(response.headers),
  });
}

export async function request(fetchImpl, url, init, label) {
  try {
    return await fetchImpl(url, { ...init, redirect: "error" });
  } catch {
    if (init.signal?.aborted) throw new LogiccError(504, label + " cancelled or timed out.");
    throw new LogiccError(502, label + " connection failed.");
  }
}

async function readJson(response, label) {
  try { return await response.json(); }
  catch { throw new LogiccError(502, label + " returned invalid JSON."); }
}

// Both endpoints are fixed to this Clerk instance. Never forward cookie values
// through a redirect, error body or an arbitrary URL supplied by the caller.
export async function refreshAuth(auth, { fetchImpl = fetch, signal, persistRotation } = {}) {
  let cookie = auth?.refresh;
  let sid = auth?.metadata?.sessionId;
  if (!validCookie(cookie)) throw expired("Missing or invalid Logicc sign-in credential.");
  if (sid != null && sid !== "" && !validSession(sid)) throw expired("Invalid Logicc session ID.");
  const timeout = AbortSignal.timeout(20_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const send = async (path, method) => {
    const response = await request(fetchImpl, CLERK + path, {
      method,
      signal: requestSignal,
      headers: { Cookie: "__client=" + cookie, Origin: APP, Accept: "application/json" },
    }, "Logicc sign-in");
    cookie = rotatedCookie(response, cookie);
    if (!response.ok) {
      await response.body?.cancel();
      throw httpError(response, "Logicc sign-in", { signIn: true });
    }
    return readJson(response, "Logicc sign-in");
  };

  try {
    if (!sid) {
      const data = await send("/v1/client", "GET");
      const client = data.response ?? data.client ?? data;
      const active = Array.isArray(client?.sessions) ? client.sessions.filter(s =>
        s?.status === "active" && validSession(s.id)) : [];
      const preferred = client?.last_active_session_id ?? client?.lastActiveSessionId;
      sid = active.find(s => s.id === preferred)?.id ?? (active.length === 1 ? active[0].id : undefined);
      if (!validSession(sid)) throw expired("No unique active Logicc session; enter its session ID.");
    }
    const data = await send("/v1/client/sessions/" + encodeURIComponent(sid) + "/tokens", "POST");
    const jwt = data?.jwt;
    const payload = claims(jwt);
    if (typeof jwt !== "string" || payload.sid !== sid || !Number.isFinite(payload.exp) ||
        payload.exp * 1000 <= Date.now() + REFRESH_LEAD) {
      throw expired("Logicc returned an invalid or expired session token.");
    }
    return {
      access: jwt,
      refresh: cookie,
      expires: payload.exp * 1000,
      metadata: { ...auth.metadata, sessionId: sid },
      accountId: "Logicc " + createHash("sha256").update(typeof payload.sub === "string" && payload.sub ? payload.sub : sid).digest("hex").slice(0, 12),
    };
  } catch (error) {
    // A successful credential rotation must not be lost if the next request
    // failed transiently. The host stores the full account, not just the cookie.
    if (cookie !== auth.refresh && error.signIn !== "expired" && persistRotation) {
      await persistRotation({ ...auth, refresh: cookie, metadata: { ...auth.metadata, ...(sid ? { sessionId: sid } : {}) } });
    }
    throw error;
  }
}

export function createAuthManager(client, fetchImpl) {
  const pending = new Map();
  const fallbackPending = new Map();
  const save = async (auth) => {
    if (!client?.auth?.set) throw new LogiccError(500, "Magpie cannot persist the renewed sign-in.");
    try { await client.auth.set({ path: { id: ID }, body: auth }); }
    catch { throw new LogiccError(500, "Magpie could not persist the renewed sign-in."); }
  };
  const renew = (auth) => {
    if (auth?.type !== "oauth") return Promise.reject(expired());
    const sid = auth.metadata?.sessionId;
    if (!validSession(sid)) return Promise.reject(expired());
    if (pending.has(sid)) return pending.get(sid);
    const operation = refreshAuth(auth, { fetchImpl, persistRotation: save })
      .finally(() => pending.delete(sid));
    pending.set(sid, operation);
    return operation;
  };
  const ensure = async (getAuth, { force = false, previous } = {}) => {
    const auth = await getAuth();
    if (auth?.type !== "oauth") throw expired();
    if (isFresh(auth) && (!force || (previous && auth.access !== previous))) return auth;
    const sid = auth.metadata?.sessionId;
    if (!validSession(sid)) throw expired();
    if (fallbackPending.has(sid)) return fallbackPending.get(sid);
    const operation = renew(auth).then(async renewed => {
      const updated = { ...auth, ...renewed, type: "oauth" };
      await save(updated);
      return updated;
    }).finally(() => fallbackPending.delete(sid));
    fallbackPending.set(sid, operation);
    return operation;
  };
  return { renew, ensure };
}

export async function apiRequest(manager, getAuth, fetchImpl, path, { body, signal, stream = false } = {}) {
  let auth = await manager.ensure(getAuth);
  const send = async () => request(fetchImpl, API + "/" + path, {
    method: body === undefined ? "GET" : "POST",
    signal,
    headers: {
      Authorization: "Bearer " + auth.access,
      Accept: stream ? "text/event-stream" : "application/json",
      ...(stream ? { "Stream-Response-Protocol": "ai-sdk-v6" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, "Logicc API");
  let response = await send();
  if (response.status === 401) {
    await response.body?.cancel();
    auth = await manager.ensure(getAuth, { force: true, previous: auth.access });
    response = await send();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw httpError(response, "Logicc API", { signIn: response.status === 401 });
  }
  return response;
}
