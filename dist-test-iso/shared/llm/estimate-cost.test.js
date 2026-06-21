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

// src/shared/llm/estimate-cost.test.ts
var import_node_test = require("node:test");
var import_strict = __toESM(require("node:assert/strict"));

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

// src/shared/llm/estimate-cost.ts
function isLocalModel(model) {
  return model === "lm-studio" || model.startsWith("lmstudio:");
}
function costForModel(model, usage) {
  if (isLocalModel(model)) return 0;
  const info = getModelInfo(model);
  if (!info) return 0;
  return usage.inputTokens / 1e6 * info.inputPricePerMTok + usage.outputTokens / 1e6 * info.outputPricePerMTok;
}
function estimateUsageCost(byModel) {
  const entries = Object.entries(byModel).filter(([, u]) => u.inputTokens > 0 || u.outputTokens > 0);
  if (entries.length === 0) return "";
  let totalCost = 0;
  let hasLocal = false;
  let hasBillable = false;
  for (const [model, usage] of entries) {
    if (isLocalModel(model)) {
      hasLocal = true;
      continue;
    }
    const cost = costForModel(model, usage);
    if (cost > 0) hasBillable = true;
    totalCost += cost;
  }
  if (!hasBillable && hasLocal) return "free (local)";
  if (totalCost === 0) return "";
  const costStr = totalCost < 0.01 ? "<$0.01" : `~$${totalCost.toFixed(2)}`;
  return hasLocal ? `${costStr} (+ local free)` : costStr;
}
function formatThreadUsageCost(usage, fallbackChatModel) {
  if (usage.byModel && Object.keys(usage.byModel).length > 0) {
    return estimateUsageCost(usage.byModel);
  }
  if (!usage.inputTokens && !usage.outputTokens) return "";
  return estimateUsageCost({
    [fallbackChatModel]: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  });
}

// src/shared/llm/estimate-cost.test.ts
(0, import_node_test.describe)("estimateUsageCost", () => {
  (0, import_node_test.it)("prices cloud models only", () => {
    const cost = estimateUsageCost({
      "claude-sonnet-4-6": { inputTokens: 1e6, outputTokens: 0 },
      "lmstudio:qwen": { inputTokens: 5e5, outputTokens: 2e5 }
    });
    import_strict.default.equal(cost, "~$3.00 (+ local free)");
  });
  (0, import_node_test.it)("prices Opus 4.8 at the current $5 / $25 per MTok rate", () => {
    const cost = estimateUsageCost({
      "claude-opus-4-8": { inputTokens: 1e6, outputTokens: 1e6 }
    });
    import_strict.default.equal(cost, "~$30.00");
  });
  (0, import_node_test.it)("returns free for all-local usage", () => {
    import_strict.default.equal(
      estimateUsageCost({ "lmstudio:local": { inputTokens: 5e4, outputTokens: 1e4 } }),
      "free (local)"
    );
  });
  (0, import_node_test.it)("formats legacy thread usage via fallback chat model", () => {
    import_strict.default.equal(
      formatThreadUsageCost({ inputTokens: 1e6, outputTokens: 0 }, "claude-sonnet-4-6"),
      "~$3.00"
    );
  });
});
