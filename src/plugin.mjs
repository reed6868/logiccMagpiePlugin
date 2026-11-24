import { API, ID, REFRESH_LEAD, LogiccError, createAuthManager, refreshAuth, apiRequest, parseClientCredential, validSession } from "./auth.mjs";
import { DEFAULT_MODEL, SDK, listModels, runtimeModels, createModelCatalog } from "./models.mjs";
import { normalize, buildPrompt } from "./prompt.mjs";
import { openAIResponse, errorResponse } from "./stream.mjs";

const failed = error => ({ type: "failed", error: error instanceof LogiccError ? error.message :
  "Logicc sign-in failed. Check your authorized credentials and try again." });
const INPUT_BUDGET = 32 * 1024 * 1024;
const PROMPT_BUDGET = 16 * 1024 * 1024;
const GENERATION_TIMEOUT = 900_000;

async function readBounded(request) {
  if (!request.body) return "";
  const length = Number(request.headers.get("content-length"));
  if (length > INPUT_BUDGET) throw new LogiccError(413, "Request exceeds the 32 MiB input budget.");
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > INPUT_BUDGET) {
        await reader.cancel();
        throw new LogiccError(413, "Request exceeds the 32 MiB input budget.");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export function createPlugin({ client, fetchImpl = globalThis.fetch } = {}) {
  const manager = createAuthManager(client, fetchImpl);
  const catalog = createModelCatalog(manager, fetchImpl);
  async function signIn(cookie, sid, signal) {
    try {
      if (signal?.aborted) throw new LogiccError(400, "Logicc sign-in cancelled.");
      let auth = await refreshAuth({ refresh: cookie, metadata: { ...(sid ? { sessionId: sid } : {}) } },
        { fetchImpl, signal });
      // Verify catalogue access before handing the account to the host.
      // Actual inference is covered separately by the live E2E.
      const getAuth = async () => ({ ...auth, type: "oauth" });
      const loginManager = {
        async ensure(_getAuth, { force = false } = {}) {
          if (force) auth = await refreshAuth(auth, { fetchImpl, signal });
          return getAuth();
        },
      };
      const models = await listModels(loginManager, getAuth, fetchImpl, signal);
      if (signal?.aborted) throw new LogiccError(400, "Logicc sign-in cancelled.");
      const { defaultId } = catalog.remember(auth, models);
      auth = { ...auth, metadata: { ...auth.metadata, defaultModelId: defaultId } };
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
          label: "Logicc authorized credential import (optional session ID)",
          prompts: [
            { type: "password", key: "cookie", message: "Existing authorized Logicc client credential (sensitive)",
              validate: v => parseClientCredential(v) ? undefined : "Enter a valid authorized client credential." },
            { type: "text", key: "sid", message: "Session ID (sess_..., or leave empty for discovery)",
              validate: v => !v?.trim() || validSession(v.trim()) ? undefined : "Invalid sess_ ID." },
          ],
          async authorize(inputs = {}, { signal } = {}) {
            const cookie = parseClientCredential(inputs.cookie);
            const sid = inputs.sid?.trim();
            if (!cookie || (sid && !validSession(sid))) return { type: "failed", error: "Invalid Logicc sign-in input." };
            return {
              url: "", method: "auto", instructions: "Verifying your Logicc sign-in.",
              callback: (_code, { signal: callbackSignal } = {}) => {
                const signals = [signal, callbackSignal].filter(Boolean);
                return signIn(cookie, sid, signals.length > 1 ? AbortSignal.any(signals) : signals[0]);
              },
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
              const raw = await readBounded(request);
              let body;
              try { body = JSON.parse(raw); } catch { throw new LogiccError(400, "Invalid JSON request."); }
              const req = normalize(body);
              const cancellation = new AbortController();
              const signal = AbortSignal.any([request.signal, cancellation.signal, AbortSignal.timeout(GENERATION_TIMEOUT)]);
              if (req.model === "default") {
                const { models, defaultId } = await catalog.get(getAuth, signal);
                if (!models.some(m => m.id === defaultId)) {
                  throw new LogiccError(409, "The pinned default model is no longer available. Select an explicit Logicc model.");
                }
                req.model = defaultId;
              }
              const prompt = buildPrompt(req);
              if (Buffer.byteLength(prompt) > PROMPT_BUDGET) throw new LogiccError(413, "Prompt exceeds the 16 MiB text budget.");
              const create = await apiRequest(manager, getAuth, fetchImpl, "chats", {
                body: {}, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              });
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
        try {
          const snapshot = await catalog.get(async () => auth);
          return runtimeModels(snapshot.models, provider, snapshot.defaultId);
        } catch (error) {
          if (error?.signIn === "expired" || error.status === 401 || error.status === 403) throw error;
          return provider.models;
        }
      },
    },
  };
}
