var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/main/services/resolve-context-window.test.ts
var import_node_test = require("node:test");
var import_strict = __toESM(require("node:assert/strict"));

// src/shared/lm-studio-api-key.ts
function resolveLmStudioApiKey(storedKey, env) {
  const stored = storedKey?.trim();
  if (stored) return stored;
  const fromEnv = env.LM_STUDIO_API_KEY?.trim() || env.LM_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return "lm-studio";
}

// src/main/services/settings.test-shim.ts
var settings = /* @__PURE__ */ new Map();
var apiKeys = /* @__PURE__ */ new Map();
function getApiKey(provider) {
  return apiKeys.get(provider) ?? null;
}
function setApiKey(provider, key) {
  apiKeys.set(provider, key.trim());
}
function getLmStudioApiKey() {
  return resolveLmStudioApiKey(getApiKey("lmstudio"), process.env);
}
function getSetting(key, fallback) {
  return settings.get(key) ?? fallback;
}

// src/shared/lm-studio-defaults.ts
var LM_STUDIO_MODEL_IDS = {
  chat: "qwen/qwen3.6-35b-a3b",
  smallTasks: "google/gemma-4-e4b",
  safety: "qwen/qwen3-4b-2507"
};
var DEFAULT_APP_CHAT_MODEL = `lmstudio:${LM_STUDIO_MODEL_IDS.chat}`;

// src/shared/llm/model-catalog.generated.ts
var MODEL_CATALOG = {
  "claude-haiku-4-5": { inputPricePerMTok: 1, outputPricePerMTok: 5, contextWindow: 2e5 },
  "claude-opus-4-8": { inputPricePerMTok: 5, outputPricePerMTok: 25, contextWindow: 1e6 },
  "claude-sonnet-4-6": { inputPricePerMTok: 3, outputPricePerMTok: 15, contextWindow: 1e6 },
  "gpt-4o": { inputPricePerMTok: 2.5, outputPricePerMTok: 10, contextWindow: 128e3 },
  "gpt-4o-mini": { inputPricePerMTok: 0.15, outputPricePerMTok: 0.6, contextWindow: 128e3 }
};

// src/shared/llm/model-catalog.ts
function getModelInfo(model) {
  return MODEL_CATALOG[model] ?? null;
}

// src/main/services/lm-studio-models.ts
var DEFAULT_LM_STUDIO_URL = "http://localhost:1234/v1";
function lmStudioApiKey(override) {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  return getLmStudioApiKey();
}
function lmStudioOrigin(openAiBaseUrl) {
  const trimmed = (openAiBaseUrl || DEFAULT_LM_STUDIO_URL).replace(/\/$/, "");
  return trimmed.replace(/\/v1$/i, "");
}
function parsePositiveInt(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = parseInt(value, 10);
    return n > 0 ? n : null;
  }
  return null;
}
function parseContextFromModelRecord(record) {
  const direct = [
    record.max_context_length,
    record.context_length,
    record.contextLength,
    record.n_ctx,
    record.max_model_len,
    record.loaded_context_length,
    record.session_context_length
  ];
  for (const value of direct) {
    const n = parsePositiveInt(value);
    if (n) return n;
  }
  for (const nestedKey of ["load_config", "loadConfig", "config", "runtime", "state"]) {
    const nested = record[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const fromNested = parseContextFromModelRecord(nested);
      if (fromNested) return fromNested;
    }
  }
  return null;
}
function parseOpenAiModelsPayload(json) {
  const data = json?.data;
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const rec = row;
    const id = typeof rec.id === "string" ? rec.id : typeof rec.model === "string" ? rec.model : null;
    if (!id) continue;
    out.push({ id, contextLength: parseContextFromModelRecord(rec) });
  }
  return out;
}
function effectiveContextFromNativeModelRecord(record) {
  const loaded = record.loaded_instances;
  if (Array.isArray(loaded)) {
    for (const inst of loaded) {
      if (!inst || typeof inst !== "object") continue;
      const config = inst.config;
      if (config && typeof config === "object" && !Array.isArray(config)) {
        const n = parsePositiveInt(config.context_length);
        if (n) return n;
      }
    }
  }
  return parsePositiveInt(record.max_context_length);
}
function parseNativeV1ModelsPayload(json) {
  const root = json;
  const list = root.models ?? root.data;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const rec = row;
    const id = typeof rec.key === "string" && rec.key || typeof rec.id === "string" && rec.id || typeof rec.identifier === "string" && rec.identifier || typeof rec.model_key === "string" && rec.model_key || null;
    if (!id) continue;
    out.push({ id, contextLength: effectiveContextFromNativeModelRecord(rec) });
  }
  return out;
}
function mergeOpenAiWithNativeContext(openAi, native) {
  const contextById = /* @__PURE__ */ new Map();
  for (const m of native) {
    if (m.contextLength) contextById.set(m.id, m.contextLength);
  }
  if (openAi.length === 0) return native;
  return openAi.map((m) => ({
    id: m.id,
    contextLength: contextById.get(m.id) ?? m.contextLength
  }));
}
async function fetchJson(url, apiKey) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4e3),
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) {
      return { ok: false, status: res.status, statusText: res.statusText };
    }
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false };
  }
}
async function fetchLmStudioModels(openAiBaseUrl, apiKey) {
  const base = (openAiBaseUrl || DEFAULT_LM_STUDIO_URL).replace(/\/$/, "");
  const key = lmStudioApiKey(apiKey);
  const origin = lmStudioOrigin(base);
  const [openAi, native] = await Promise.all([
    fetchJson(`${base}/models`, key),
    fetchJson(`${origin}/api/v1/models`, key)
  ]);
  const openAiModels = openAi.ok && openAi.json ? parseOpenAiModelsPayload(openAi.json) : [];
  const nativeModels = native.ok && native.json ? parseNativeV1ModelsPayload(native.json) : [];
  const merged = mergeOpenAiWithNativeContext(openAiModels, nativeModels);
  if (merged.length > 0) return { ok: true, models: merged };
  if (openAi.ok) return { ok: true, models: openAiModels };
  const status = openAi.status;
  const statusText = openAi.statusText;
  if (status) {
    return {
      ok: false,
      models: [],
      error: `HTTP ${status}${statusText ? ` ${statusText}` : ""}`
    };
  }
  return {
    ok: false,
    models: [],
    error: "Could not list models from LM Studio"
  };
}
function contextLengthForModel(models, modelId) {
  const row = models.find((m) => m.id === modelId);
  return row?.contextLength ?? null;
}
var LM_MODELS_TTL_MS = 6e4;
var lmModelsCache = null;
function invalidateLmStudioModelsCache() {
  lmModelsCache = null;
}
async function fetchLmStudioModelsCached(openAiBaseUrl, apiKey) {
  const url = (openAiBaseUrl || DEFAULT_LM_STUDIO_URL).replace(/\/$/, "");
  const key = lmStudioApiKey(apiKey);
  const cacheKey = `${url}${key}`;
  const now = Date.now();
  if (lmModelsCache && lmModelsCache.key === cacheKey && now - lmModelsCache.at < LM_MODELS_TTL_MS) {
    return lmModelsCache.result;
  }
  const result = await fetchLmStudioModels(url, key);
  lmModelsCache = { key: cacheKey, at: now, result };
  return result;
}

// src/main/services/resolve-context-window.ts
var DEFAULT_LM_STUDIO_URL2 = "http://localhost:1234/v1";
var DEFAULT_LOCAL_CONTEXT = 8192;
var DEFAULT_CLOUD_CONTEXT = 128e3;
function localModelId(model) {
  if (model.startsWith("lmstudio:")) return model.slice("lmstudio:".length);
  if (model === "lm-studio")
    return getSetting("lmStudioModel", LM_STUDIO_MODEL_IDS.chat).trim() || null;
  return null;
}
async function fetchLmStudioModelContextLength(baseURL, modelId) {
  const r = await fetchLmStudioModelsCached(baseURL);
  if (!r.ok) return null;
  return contextLengthForModel(r.models, modelId);
}
async function resolveContextWindow(model) {
  const cloud = getModelInfo(model);
  if (cloud) return cloud.contextWindow;
  if (model === "lm-studio" || model.startsWith("lmstudio:")) {
    const url = getSetting("lmStudioUrl", DEFAULT_LM_STUDIO_URL2);
    const id = localModelId(model);
    if (id) {
      const r = await fetchLmStudioModelsCached(url);
      if (r.ok) {
        const fromServer = contextLengthForModel(r.models, id);
        if (fromServer) return fromServer;
      }
    }
    return DEFAULT_LOCAL_CONTEXT;
  }
  return DEFAULT_CLOUD_CONTEXT;
}

// src/main/services/resolve-context-window.test.ts
function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}
(0, import_node_test.describe)("resolveContextWindow", () => {
  (0, import_node_test.beforeEach)(() => {
    invalidateLmStudioModelsCache();
  });
  (0, import_node_test.it)("uses cloud model table", async () => {
    import_strict.default.equal(await resolveContextWindow("gpt-4o"), 128e3);
  });
  (0, import_node_test.it)("uses context from /models when the server reports it", async () => {
    const restoreFetch = stubFetch(async (input) => {
      const url = requestUrl(input);
      if (String(url).includes("/api/v1/models")) {
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                key: "qwen",
                max_context_length: 262144,
                loaded_instances: [{ config: { context_length: 16384 } }]
              }
            ]
          })
        };
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: "qwen" }] })
      };
    });
    try {
      import_strict.default.equal(await resolveContextWindow("lmstudio:qwen"), 16384);
    } finally {
      restoreFetch();
    }
  });
  (0, import_node_test.it)("defaults local models to 8192 when the server omits context", async () => {
    const restoreFetch = stubFetch(async (input) => {
      const url = requestUrl(input);
      if (String(url).includes("/api/v1/models")) {
        return { ok: true, json: async () => ({ models: [{ key: "qwen" }] }) };
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: "qwen" }] })
      };
    });
    try {
      import_strict.default.equal(await resolveContextWindow("lmstudio:qwen"), 8192);
    } finally {
      restoreFetch();
    }
  });
});
(0, import_node_test.describe)("fetchLmStudioModelContextLength", () => {
  let restoreFetch;
  (0, import_node_test.afterEach)(() => {
    restoreFetch?.();
  });
  (0, import_node_test.beforeEach)(() => {
    invalidateLmStudioModelsCache();
    setApiKey("lmstudio", "test-key");
  });
  (0, import_node_test.it)("reads max_context_length from /models when present", async () => {
    restoreFetch = stubFetch(async (input) => {
      const url = requestUrl(input);
      if (String(url).includes("/api/v1/models")) {
        return {
          ok: true,
          json: async () => ({
            models: [{ key: "qwen", max_context_length: 32768, loaded_instances: [] }]
          })
        };
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: "qwen" }] })
      };
    });
    import_strict.default.equal(await fetchLmStudioModelContextLength("http://127.0.0.1:1234/v1", "qwen"), 32768);
  });
});
