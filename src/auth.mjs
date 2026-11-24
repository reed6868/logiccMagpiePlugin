// Clerk sign-in adaptation from logicc2api/pool.mjs (MIT; see LICENSE).
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
export const ID = "logicc";
export const APP = "https://app.logicc.com";
export const API = APP + "/api";
const CLERK = "https://clerk.logicc.com";
export const REFRESH_LEAD = 10_000;
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_SCOPE = "openid offline_access";
const DEVICE_URL = CLERK + "/oauth/device_authorization";
const TOKEN_URL = CLERK + "/oauth/token";
const USERINFO_URL = CLERK + "/oauth/userinfo";

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
  if (auth?.metadata?.oauthGrant === "device") {
    return Boolean(authKey(auth) && validOAuthToken(auth.access) &&
      Number.isFinite(auth.expires) && auth.expires > now + REFRESH_LEAD);
  }
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

// RFC 8628: a provider-registered public OAuth client, with the authorization
// page opened by Magpie in the system browser. No browser session inspection.
export function validClientId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{1,256}$/.test(value);
}

function validOAuthToken(value) {
  return typeof value === "string" && /^[\x21-\x7e]{1,32768}$/.test(value);
}

function withTimeout(signal, ms = 20_000) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function oauthForm(url, fields, fetchImpl, signal) {
  const response = await request(fetchImpl, url, {
    method: "POST",
    signal: withTimeout(signal),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }, "Logicc OAuth");
  if (response.status === 429) {
    await response.body?.cancel();
    throw httpError(response, "Logicc OAuth");
  }
  const data = await readJson(response, "Logicc OAuth");
  return { response, data };
}

function oauthFailure(response, data) {
  if (response.status === 429) return httpError(response, "Logicc OAuth");
  switch (data?.error) {
    case "invalid_client":
    case "unauthorized_client":
      return new LogiccError(400, "Logicc requires an approved public OAuth client ID with device authorization enabled.");
    case "invalid_scope":
      return new LogiccError(400, "Logicc has not enabled the requested OAuth permissions for this client.");
    case "access_denied":
      return new LogiccError(403, "Logicc OAuth consent was declined.");
    case "expired_token":
      return expired("Logicc device code expired; start sign-in again.");
    case "invalid_grant":
      return expired("Logicc OAuth grant expired or was revoked; sign in again.");
    default:
      return httpError(response, "Logicc OAuth");
  }
}

function verificationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
        (url.hostname === "logicc.com" || url.hostname.endsWith(".logicc.com"))) return url.href;
  } catch {}
  throw new LogiccError(502, "Logicc returned an untrusted verification URL.");
}

export async function beginDeviceAuthorization(clientId, { fetchImpl = fetch, signal } = {}) {
  if (!validClientId(clientId)) {
    throw new LogiccError(400, "An OAuth client ID issued by Logicc is required; it is not an API key.");
  }
  const response = await request(fetchImpl, CLERK + "/.well-known/openid-configuration", {
    method: "GET", signal: withTimeout(signal), headers: { Accept: "application/json" },
  }, "Logicc OAuth discovery");
  if (!response.ok) {
    await response.body?.cancel();
    throw httpError(response, "Logicc OAuth discovery");
  }
  const metadata = await readJson(response, "Logicc OAuth discovery");
  if (metadata?.issuer !== CLERK || metadata.device_authorization_endpoint !== DEVICE_URL ||
      metadata.token_endpoint !== TOKEN_URL || metadata.userinfo_endpoint !== USERINFO_URL ||
      !Array.isArray(metadata.grant_types_supported) || !metadata.grant_types_supported.includes(DEVICE_GRANT) ||
      !Array.isArray(metadata.token_endpoint_auth_methods_supported) || !metadata.token_endpoint_auth_methods_supported.includes("none") ||
      !Array.isArray(metadata.scopes_supported) || !DEVICE_SCOPE.split(" ").every(scope => metadata.scopes_supported.includes(scope))) {
    throw new LogiccError(502, "Logicc has not advertised the required public device OAuth endpoints and permissions.");
  }
  const { response: res, data } = await oauthForm(DEVICE_URL,
    { client_id: clientId, scope: DEVICE_SCOPE }, fetchImpl, signal);
  if (!res.ok) throw oauthFailure(res, data);
  const url = verificationUrl(data?.verification_uri);
  const interval = data?.interval ?? 5;
  if (!validOAuthToken(data?.device_code) || typeof data.user_code !== "string" ||
      !/^[A-Za-z0-9 -]{1,64}$/.test(data.user_code) || !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 || !Number.isFinite(interval) || interval < 1) {
    throw new LogiccError(502, "Logicc returned an invalid device authorization response.");
  }
  return { clientId, url, userCode: data.user_code, deviceCode: data.device_code,
    deadline: Date.now() + Math.min(data.expires_in, 900) * 1000,
    interval: Math.ceil(interval) };
}

function oauthTokens(data, previousRefresh) {
  const refresh = data?.refresh_token ?? previousRefresh;
  if (!validOAuthToken(data?.access_token) || !validOAuthToken(refresh) ||
      String(data.token_type).toLowerCase() !== "bearer" ||
      !Number.isFinite(data.expires_in) || data.expires_in * 1000 <= REFRESH_LEAD ||
      data.expires_in > 31 * 24 * 60 * 60) {
    throw new LogiccError(502, "Logicc did not issue a valid renewable OAuth access token.");
  }
  return { access: data.access_token, refresh, expires: Date.now() + data.expires_in * 1000 };
}

export async function completeDeviceAuthorization(device, {
  fetchImpl = fetch, signal, wait = (ms, activeSignal) => sleep(ms, undefined, { signal: activeSignal }),
} = {}) {
  if (signal?.aborted) throw new LogiccError(400, "Logicc OAuth sign-in cancelled.");
  if (!Number.isFinite(device?.deadline) || device.deadline <= Date.now()) {
    throw expired("Logicc device code expired; start sign-in again.");
  }
  const activeSignal = withTimeout(signal, Math.max(1, Math.ceil(device.deadline - Date.now())));
  let interval = device.interval;
  try {
    for (;;) {
      await wait(interval * 1000, activeSignal);
      if (activeSignal.aborted || Date.now() >= device.deadline) break;
      const { response, data } = await oauthForm(TOKEN_URL, {
        grant_type: DEVICE_GRANT, client_id: device.clientId, device_code: device.deviceCode,
      }, fetchImpl, activeSignal);
      if (!response.ok) {
        if (response.status === 400 && data?.error === "authorization_pending") continue;
        if (response.status === 400 && data?.error === "slow_down") { interval += 5; continue; }
        throw oauthFailure(response, data);
      }
      const tokens = oauthTokens(data);
      const who = await request(fetchImpl, USERINFO_URL, {
        method: "GET", signal: withTimeout(activeSignal),
        headers: { Authorization: "Bearer " + tokens.access, Accept: "application/json" },
      }, "Logicc OAuth identity");
      if (!who.ok) {
        await who.body?.cancel();
        throw httpError(who, "Logicc OAuth identity");
      }
      const info = await readJson(who, "Logicc OAuth identity");
      if (typeof info?.sub !== "string" || !info.sub || info.sub.length > 512) {
        throw new LogiccError(502, "Logicc OAuth did not identify the account.");
      }
      const accountHash = createHash("sha256").update(JSON.stringify([
        device.clientId, info.sub, typeof info.org_id === "string" ? info.org_id : "",
      ])).digest("hex").slice(0, 24);
      if (activeSignal.aborted) break;
      return { ...tokens, accountId: "Logicc OAuth " + accountHash,
        metadata: { oauthGrant: "device", clientId: device.clientId } };
    }
  } catch (error) {
    if (!activeSignal.aborted) throw error;
  }
  if (signal?.aborted) throw new LogiccError(400, "Logicc OAuth sign-in cancelled.");
  throw expired("Logicc device code expired; start sign-in again.");
}

async function refreshDeviceAuth(auth, fetchImpl) {
  if (!validClientId(auth.metadata?.clientId) || !validOAuthToken(auth.refresh)) throw expired();
  const { response, data } = await oauthForm(TOKEN_URL, {
    grant_type: "refresh_token", client_id: auth.metadata.clientId, refresh_token: auth.refresh,
  }, fetchImpl);
  if (!response.ok) throw oauthFailure(response, data);
  return { ...oauthTokens(data, auth.refresh), metadata: auth.metadata, accountId: auth.accountId };
}

function authKey(auth) {
  if (auth?.metadata?.oauthGrant === "device") {
    return validClientId(auth.metadata.clientId) && /^Logicc OAuth [a-f0-9]{24}$/.test(auth.accountId ?? "")
      ? "device:" + auth.metadata.clientId + ":" + auth.accountId : null;
  }
  return validSession(auth?.metadata?.sessionId) ? "session:" + auth.metadata.sessionId : null;
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
    const key = authKey(auth);
    if (!key) return Promise.reject(expired());
    if (pending.has(key)) return pending.get(key);
    const operation = (auth.metadata.oauthGrant === "device"
      ? refreshDeviceAuth(auth, fetchImpl)
      : refreshAuth(auth, { fetchImpl, persistRotation: save }))
      .finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
  const ensure = async (getAuth, { force = false, previous } = {}) => {
    const auth = await getAuth();
    if (auth?.type !== "oauth") throw expired();
    if (isFresh(auth) && (!force || (previous && auth.access !== previous))) return auth;
    const key = authKey(auth);
    if (!key) throw expired();
    if (fallbackPending.has(key)) return fallbackPending.get(key);
    const operation = renew(auth).then(async renewed => {
      const updated = { ...auth, ...renewed, type: "oauth" };
      await save(updated);
      return updated;
    }).finally(() => fallbackPending.delete(key));
    fallbackPending.set(key, operation);
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
