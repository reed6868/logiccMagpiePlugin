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
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  let data;
  try { data = await response.json(); } catch { throw new LogiccError(502, "Logicc model list was not JSON."); }
  const list = Array.isArray(data) ? data : data?.models ?? data?.data;
  if (!Array.isArray(list)) throw new LogiccError(502, "Invalid Logicc model list.");
  const models = list.filter(m => typeof (m?.id ?? m?.modelId) === "string" && (m.id ?? m.modelId).length)
    .map(m => ({
      id: m.id ?? m.modelId,
      name: typeof m.name === "string" ? m.name : m.id ?? m.modelId,
      isDefault: Boolean(m.isDefault),
      context: m.limit?.context ?? m.contextWindow ?? m.contextLength,
      output: m.limit?.output ?? m.maxOutputTokens,
    }));
  if (!models.length) throw new LogiccError(502, "Logicc returned no account models.");
  return models;
}

const positiveInt = (value, fallback) => Number.isInteger(value) && value > 0 ? value : fallback;

export function runtimeModels(models, provider) {
  const base = provider?.models?.default ?? {};
  return Object.fromEntries(models.map(m => {
    const template = provider?.models?.[m.id] ?? base;
    return [m.id, {
      ...template,
      id: m.id,
      name: m.name,
      providerID: ID,
      api: { id: m.id, url: API, npm: SDK },
      limit: { context: positiveInt(m.context, FALLBACK_LIMIT.context), output: positiveInt(m.output, FALLBACK_LIMIT.output) },
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
}
