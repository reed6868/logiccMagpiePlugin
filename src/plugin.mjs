import { API, ID, REFRESH_LEAD, LogiccError, createAuthManager, refreshAuth, apiRequest, validCookie, validSession,
  validClientId, beginDeviceAuthorization, completeDeviceAuthorization } from "./auth.mjs";
import { DEFAULT_MODEL, SDK, listModels, runtimeModels } from "./models.mjs";
import { normalize, buildPrompt } from "./prompt.mjs";
import { openAIResponse, errorResponse } from "./stream.mjs";

const failed = error => ({ type: "failed", error: error instanceof LogiccError ? error.message :
  "Logicc sign-in failed. Check the browser or sign in again." });

// A public client registration belongs to the plugin, not the person signing
// in. Leave unset until Logicc explicitly provisions an authorized client.
const REGISTERED_CLIENT_ID = undefined;

export function createPlugin({ client, fetchImpl = globalThis.fetch, deviceWait,
  registeredClientId = REGISTERED_CLIENT_ID } = {}) {
  const manager = createAuthManager(client, fetchImpl);
  async function signIn(cookie, sid, signal) {
    try {
      let auth = await refreshAuth({ refresh: cookie, metadata: { ...(sid ? { sessionId: sid } : {}) } },
        { fetchImpl, signal });
      // Confirm that the account actually has access to Logicc models.
      // Do not write to a host account until the login callback succeeds.
      const getAuth = async () => ({ ...auth, type: "oauth" });
      const loginManager = {
        async ensure(_getAuth, { force = false } = {}) {
          if (force) auth = await refreshAuth(auth, { fetchImpl, signal });
          return getAuth();
        },
      };
      await listModels(loginManager, getAuth, fetchImpl, signal);
      return { type: "success", ...auth };
    } catch (error) { return failed(error); }
  }
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[ID] ??= { name: "Logicc", npm: SDK, api: API, models: { default: DEFAULT_MODEL } };
    },
    auth: {
      provider: ID,
      methods: [
        {
          type: "oauth",
          label: "Sign in to Logicc (browser)",
          async authorize(_inputs, { signal } = {}) {
            if (!validClientId(registeredClientId)) {
              return { type: "failed", error: "Logicc has not enabled a supported OAuth authorization for this plugin. You do not need to enter a client ID or API key. Browser sign-in is not available yet." };
            }
            let device;
            try { device = await beginDeviceAuthorization(registeredClientId, { fetchImpl, signal }); }
            catch (error) { return failed(error); }
            return {
              url: device.url,
              method: "auto",
              instructions: "Sign in and consent in your normal browser. " +
                (device.complete ? "Confirm the code " : "Enter the code ") + device.userCode +
                " if requested. Magpie will finish after Logicc authorizes the client.",
              async callback(_code, { signal: callbackSignal } = {}) {
                const signals = [signal, callbackSignal].filter(Boolean);
                const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
                try {
                  const auth = await completeDeviceAuthorization(device, { fetchImpl, signal: combined, wait: deviceWait });
                  const getAuth = async () => ({ ...auth, type: "oauth" });
                  // A Clerk OAuth grant is not proof that Logicc's inference
                  // endpoint accepts the token. Verify before saving any account.
                  const verifyManager = { async ensure(_getAuth, { force = false } = {}) {
                    if (force) throw new LogiccError(401, "Logicc does not accept this OAuth token for model access.");
                    return getAuth();
                  } };
                  try { await listModels(verifyManager, getAuth, fetchImpl, combined); }
                  catch (error) {
                    if (error.status === 401 || error.status === 403) {
                      throw new LogiccError(error.status, "Logicc OAuth consent succeeded, but model access was refused. The client must be authorized for inference.");
                    }
                    throw error;
                  }
                  if (combined?.aborted) throw new LogiccError(400, "Logicc OAuth sign-in cancelled.");
                  return { type: "success", ...auth };
                } catch (error) { return failed(error); }
              },
            };
          },
        },
        {
          type: "oauth",
          label: "Logicc manual sign-in (client credential + optional session ID)",
          prompts: [
            { type: "password", key: "cookie", message: "Existing authorized Logicc client credential (sensitive)",
              validate: v => validCookie(v?.trim()) ? undefined : "Enter a valid client credential." },
            { type: "text", key: "sid", message: "Session ID (sess_..., or leave empty for discovery)",
              validate: v => !v?.trim() || validSession(v.trim()) ? undefined : "Invalid sess_ ID." },
          ],
          async authorize(inputs = {}, { signal } = {}) {
            const cookie = inputs.cookie?.trim();
            const sid = inputs.sid?.trim();
            if (!validCookie(cookie) || (sid && !validSession(sid))) return { type: "failed", error: "Invalid Logicc sign-in input." };
            return {
              url: "", method: "auto", instructions: "Verifying your Logicc sign-in.",
              callback: (_code, { signal: callbackSignal } = {}) => signIn(cookie, sid, callbackSignal ?? signal),
            };
          },
        },
      ],
      refreshLead: REFRESH_LEAD,
      refresh: auth => manager.renew(auth),
      async loader(getAuth) {
        return {
          baseURL: API,
          apiKey: "logicc",
          async fetch(input, init = {}) {
            try {
              const request = new Request(input, init);
              const url = new URL(request.url);
              if (request.method !== "POST" || url.origin !== new URL(API).origin ||
                  url.pathname !== "/api/chat/completions") {
                throw new LogiccError(400, "Only Logicc chat/completions is supported.");
              }
              const raw = await request.text();
              if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new LogiccError(413, "Request is too large.");
              let body;
              try { body = JSON.parse(raw); } catch { throw new LogiccError(400, "Invalid JSON request."); }
              const req = normalize(body);
              const cancellation = new AbortController();
              const signal = AbortSignal.any([request.signal, cancellation.signal, AbortSignal.timeout(180_000)]);
              if (req.model === "default") {
                const models = await listModels(manager, getAuth, fetchImpl, signal);
                req.model = (models.find(m => m.isDefault) ?? models[0]).id;
              }
              const prompt = buildPrompt(req);
              if (Buffer.byteLength(prompt) > 2 * 1024 * 1024) throw new LogiccError(413, "Prompt is too large.");
              const create = await apiRequest(manager, getAuth, fetchImpl, "chats", { body: {}, signal });
              let created;
              try { created = await create.json(); } catch { throw new LogiccError(502, "Logicc chat creation returned invalid JSON."); }
              const chatId = typeof created === "string" ? created : created?.id;
              if (typeof chatId !== "string" || !chatId || chatId.length > 1024) throw new LogiccError(502, "Logicc did not return a chat ID.");
              const upstream = await apiRequest(manager, getAuth, fetchImpl, "chats/" + encodeURIComponent(chatId), {
                body: { modelId: req.model, prompt, isVoicePrompt: false,
                  ...(typeof req.reasoning === "string" && req.reasoning ? { reasoningEffort: req.reasoning } : {}) },
                signal, stream: true,
              });
              return await openAIResponse(upstream.body, req, () => cancellation.abort());
            } catch (error) {
              return errorResponse(error);
            }
          },
        };
      },
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "oauth") return provider.models;
        try { return runtimeModels(await listModels(manager, async () => auth, fetchImpl), provider); }
        catch (error) {
          if (error?.signIn === "expired") throw error;
          return provider.models;
        }
      },
    },
  };
}
