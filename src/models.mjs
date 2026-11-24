// Model list shape adapted from logicc2api/server.mjs (MIT).
import { API, ID, LogiccError, apiRequest } from "./auth.mjs";

export const SDK = "@ai-sdk/openai-compatible";
const FALLBACK_LIMIT = { context: 32_768, output: 4_096 };
export const DEFAULT_MODEL = {
  name: "Logicc (account default)",
  limit: FALLBACK_LIMIT,
  tool_call: true,
  reasoning: true,
  modalities: { input: ["text"], output: ["text"] },
};

export async function listModels(manager, getAuth, fetchImpl, signal) {
  const response = await apiRequest(manager, getAuth, fetchImpl, "models?language=en", {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  let data;
  try { data = await response.json(); } catch { throw new LogiccError(502, "Logicc model list was not JSON."); }
  const list = Array.isArray(data) ? data : data?.models ?? data?.data;
  if (!Array.isArray(list)) throw new LogiccError(502, "Invalid Logicc model list.");
  const models = list.filter(m => typeof (m?.id ?? m?.modelId) === "string" && (m.id ?? m.modelId).length)
    .map(m => ({
      id: m.id ?? m.modelId,
      name: typeof m.name === "string" ? m.name : m.id ?? m.modelId,
      isDefault: m.isDefault === true || m.is_default === true,
      context: m.limit?.context ?? m.contextWindow ?? m.contextLength ?? m.context_window,
      output: m.limit?.output ?? m.maxOutputTokens ?? m.max_output_tokens,
    }));
  if (!models.length) throw new LogiccError(502, "Logicc returned no account models.");
  return models;
}

const positiveInt = (value, fallback) => Number.isInteger(value) && value > 0 ? value : fallback;

// Conservative family estimates, not vendor-verified limits. Explicit
// catalogue fields or the host's exact-model metadata always take priority.
function familyLimit(model) {
  const name = (model.id + " " + model.name).toLowerCase().replace(/[_./]/g, " ");
  if (/\bclaude\b/.test(name)) {
    return { context: 200_000, output: /opus|sonnet/.test(name) ? 32_000 : 8_192 };
  }
  if (/\bgemini\b/.test(name)) return { context: 1_000_000, output: 32_768 };
  if (/\bgpt[-_. ]?5\b/.test(name)) return { context: 400_000, output: 32_768 };
  if (/\bgpt\b|\bo[134](?:[-_. ]|\b)/.test(name)) return { context: 128_000, output: 16_384 };
  if (/\bdeepseek\b/.test(name)) return { context: 128_000, output: 8_192 };
  if (/\bqwen\b/.test(name)) return { context: 128_000, output: 8_192 };
  if (/\bgrok\b/.test(name)) return { context: 128_000, output: 16_384 };
  return FALLBACK_LIMIT;
}

export function modelLimit(model, exact) {
  const family = familyLimit(model);
  return {
    context: positiveInt(model.context, positiveInt(exact?.limit?.context, family.context)),
    output: positiveInt(model.output, positiveInt(exact?.limit?.output, family.output)),
  };
}

function preferredDefault(models) {
  const ordered = [...models].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return (ordered.find(m => m.isDefault) ?? ordered[0]).id;
}

// Per-session catalogue snapshots, bounded in memory. Pin the alias at login
// (persisted in auth.metadata) and never silently choose a different model.
export function createModelCatalog(manager, fetchImpl) {
  const snapshots = new Map();
  const remember = (auth, models, previous) => {
    const key = auth.metadata.sessionId;
    const entry = { models, defaultId: auth.metadata.defaultModelId ?? previous?.defaultId ?? preferredDefault(models) };
    snapshots.delete(key);
    snapshots.set(key, entry);
    if (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value);
    return entry;
  };
  return {
    remember(auth, models) { return remember(auth, models); },
    async get(getAuth, signal) {
      const auth = await getAuth();
      const key = auth?.metadata?.sessionId;
      const previous = snapshots.get(key);
      try {
        const models = await listModels(manager, getAuth, fetchImpl, signal);
        return remember(auth, models, snapshots.get(key));
      } catch (error) {
        if (error.signIn === "expired" || error.status === 401 || error.status === 403) {
          snapshots.delete(key);
          throw error;
        }
        if (error.status === 429 || error.status >= 500) {
          const cached = snapshots.get(key) ?? previous;
          if (cached) return cached;
        }
        throw error;
      }
    },
  };
}

export function runtimeModels(models, provider, defaultId) {
  const base = provider?.models?.default ?? {};
  const result = Object.fromEntries(models.map(m => {
    const template = provider?.models?.[m.id] ?? base;
    return [m.id, {
      ...template,
      id: m.id,
      name: m.name,
      providerID: ID,
      api: { id: m.id, url: API, npm: SDK },
      limit: modelLimit(m, provider?.models?.[m.id]),
      tool_call: true,
      reasoning: true,
      capabilities: {
        ...template.capabilities,
        reasoning: true,
        toolcall: true,
        attachment: false,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
      },
    }];
  }));
  if (defaultId && Object.hasOwn(result, defaultId) && defaultId !== "default") {
    const pinned = result[defaultId];
    result.default = { ...pinned, id: "default", name: "Logicc default (" + pinned.name + ")",
      api: { ...pinned.api, id: "default" } };
  }
  return result;
}
