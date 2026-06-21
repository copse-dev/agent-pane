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

// src/shared/agent/run-agent-loop.test.ts
var import_node_test = require("node:test");
var import_strict = __toESM(require("node:assert/strict"));

// src/shared/agent/trim-history.ts
var ESTIMATED_IMAGE_TOKENS = 1600;
var CANCELLED_TOOL_RESULT = "Tool execution cancelled.";
var lastMeasuredInputTokens = null;
function setLastMeasuredInputTokens(tokens) {
  lastMeasuredInputTokens = tokens != null && tokens > 0 ? tokens : null;
}
function estimateUserContentTokens(content) {
  if (typeof content === "string") return content.length / 4;
  let total = 0;
  for (const block of content) {
    if (block.type === "text") total += block.text.length / 4;
    else if (block.type === "image") total += ESTIMATED_IMAGE_TOKENS;
  }
  return total;
}
function estimateSingleMessageTokens(message) {
  switch (message.role) {
    case "system":
      return message.content.length / 4;
    case "user":
      return estimateUserContentTokens(message.content);
    case "assistant":
      if (typeof message.content === "string") return message.content.length / 4;
      return JSON.stringify(message.content).length / 4;
    case "tool":
      return JSON.stringify(message.toolResults).length / 4;
    default:
      return 0;
  }
}
function estimateMessageTokens(messages) {
  let total = 0;
  for (const m of messages) total += estimateSingleMessageTokens(m);
  return total;
}
function historyTokenBudget(maxContextTokens, opts) {
  const reserve = opts?.reserveTokens ?? 0;
  const completion = opts?.completionReserveTokens ?? 1024;
  const raw = maxContextTokens - reserve - completion;
  return Math.max(1, raw);
}
function systemPromptReserve(messages) {
  const sys = messages[0];
  if (sys?.role !== "system") return 0;
  return estimateMessageTokens([sys]);
}
function conversationMessages(messages) {
  const start = contentStartIndex(messages);
  return messages.slice(start);
}
function contentStartIndex(messages) {
  return messages[0]?.role === "system" ? 1 : 0;
}
function conversationTokenBudget(messages, maxContextTokens, opts) {
  const toolAndCompletion = opts?.reserveTokens ?? 0;
  const systemReserve = systemPromptReserve(messages);
  return historyTokenBudget(maxContextTokens, {
    reserveTokens: toolAndCompletion + systemReserve,
    ...opts?.completionReserveTokens !== void 0 ? { completionReserveTokens: opts.completionReserveTokens } : {}
  });
}
function estimateConversationTokens(messages) {
  const conv = conversationMessages(messages);
  let total = JSON.stringify(conv).length / 4;
  for (const m of conv) {
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "image") {
          total -= block.dataUrl.length / 4;
          total += ESTIMATED_IMAGE_TOKENS;
        }
      }
    }
  }
  return total;
}
function effectiveConversationTokens(messages) {
  if (lastMeasuredInputTokens != null) return lastMeasuredInputTokens;
  return estimateConversationTokens(messages);
}
function repairToolUseToolResultPairing(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const toolIds = m.content.map((tc) => tc.id);
    if (toolIds.length === 0) continue;
    const next = messages[i + 1];
    if (next?.role === "tool") {
      const have = new Set(next.toolResults.map((r) => r.toolCallId));
      for (const id of toolIds) {
        if (!have.has(id)) {
          next.toolResults.push({ toolCallId: id, result: CANCELLED_TOOL_RESULT });
        }
      }
    } else {
      messages.splice(i + 1, 0, {
        role: "tool",
        toolResults: toolIds.map((id) => ({
          toolCallId: id,
          result: CANCELLED_TOOL_RESULT
        }))
      });
      i++;
    }
  }
}
function droppableSpan(messages, index) {
  const m = messages[index];
  if (!m || m.role === "user") return 0;
  if (m.role === "tool") {
    const prev = messages[index - 1];
    if (prev?.role === "assistant" && Array.isArray(prev.content)) return 0;
    return 1;
  }
  if (m.role === "assistant" && Array.isArray(m.content)) {
    const next = messages[index + 1];
    if (next?.role === "tool") return 2;
  }
  return 1;
}
function findOldestDroppableIndex(messages, minTail) {
  const start = contentStartIndex(messages);
  for (let i = start; i < messages.length; i++) {
    if (messages[i]?.role === "user") continue;
    const span = droppableSpan(messages, i);
    if (span === 0) continue;
    if (messages.length - span < minTail) return -1;
    return i;
  }
  return -1;
}
function trimMessagesInPlace(messages, maxContextTokens, opts) {
  const minTail = opts?.minTailMessages ?? 5;
  const conversationBudget = conversationTokenBudget(messages, maxContextTokens, opts);
  let trimmed = false;
  repairToolUseToolResultPairing(messages);
  while (messages.length > minTail && effectiveConversationTokens(messages) > conversationBudget) {
    const dropIndex = findOldestDroppableIndex(messages, minTail);
    if (dropIndex < 0) break;
    const span = droppableSpan(messages, dropIndex);
    messages.splice(dropIndex, span);
    trimmed = true;
  }
  return trimmed;
}

// src/shared/agent/agent-loop-guards.ts
var EXPLORE_TOOL_NAMES = /* @__PURE__ */ new Set([
  "list_dir",
  "read_file",
  "find_files",
  "search_code",
  "search_codebase"
]);
function toolCallFingerprint(name, args) {
  return `${name}:${stableJson(args)}`;
}
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}
function normalizeExploreArgs(name, args) {
  if (name !== "list_dir" || !args || typeof args !== "object") return args;
  const a = args;
  const path = typeof a.path === "string" ? a.path.trim() || "." : ".";
  return { ...a, path };
}
function isDuplicateExploreCall(name, args, recentFingerprints) {
  if (!EXPLORE_TOOL_NAMES.has(name)) return false;
  const fp = toolCallFingerprint(name, normalizeExploreArgs(name, args));
  return recentFingerprints.includes(fp);
}
var LOOP_NUDGE_USER_MESSAGE = "You already explored this workspace. Use the tool results above \u2014 run the requested command with run_shell or write your final answer. Do not list the root directory again or re-read the same files.";
var STUCK_FINALIZE_NUDGE = "Stop calling tools. Write a clear final answer for the user based on the conversation so far.";
var DUPLICATE_TOOL_RESULT_PREFIX = "[Duplicate tool call skipped \u2014 same arguments as a recent step. Use prior results, run_shell if needed, or answer in text.]";

// src/shared/agent/agent-loop-escalation.ts
var SOFT_NUDGE_FILL_RATIO = 0.7;
var FORCE_TEXT_FILL_RATIO = 0.85;
var MID_FILL_RATIO = 0.5;
function escalationThresholds(conversationBudget) {
  const soft = Math.max(3, Math.floor(conversationBudget / 4e3));
  const force = Math.max(soft + 2, Math.floor(conversationBudget / 2500));
  return { softNudgeMinToolSteps: soft, forceTextMinToolSteps: force };
}
function measureConversationPressure(input) {
  const { messages, maxContextTokens, toolSchemaReserveTokens } = input;
  const conversationBudget = conversationTokenBudget(messages, maxContextTokens, {
    reserveTokens: toolSchemaReserveTokens
  });
  const conversationTokens = effectiveConversationTokens(messages);
  const fillRatio = conversationTokens / conversationBudget;
  return {
    conversationBudget,
    conversationTokens,
    fillRatio,
    thresholds: escalationThresholds(conversationBudget)
  };
}
function shouldInjectLoopNudge(input, pressure) {
  const p = pressure ?? measureConversationPressure(input);
  const { toolOnlySteps, trimEvents } = input;
  const { fillRatio, thresholds } = p;
  if (trimEvents >= 1 && toolOnlySteps >= 3 && fillRatio >= MID_FILL_RATIO) return true;
  if (fillRatio >= SOFT_NUDGE_FILL_RATIO && toolOnlySteps >= 2) return true;
  if (fillRatio >= MID_FILL_RATIO && toolOnlySteps >= thresholds.softNudgeMinToolSteps) return true;
  if (toolOnlySteps >= thresholds.softNudgeMinToolSteps + 2) return true;
  return false;
}
function shouldForceTextAnswer(input, pressure) {
  const p = pressure ?? measureConversationPressure(input);
  const { toolOnlySteps, trimEvents } = input;
  const { fillRatio, thresholds } = p;
  if (trimEvents >= 2 && fillRatio >= MID_FILL_RATIO && toolOnlySteps >= 2) return true;
  if (fillRatio >= FORCE_TEXT_FILL_RATIO && toolOnlySteps >= thresholds.forceTextMinToolSteps) {
    return true;
  }
  if (toolOnlySteps >= thresholds.forceTextMinToolSteps + 1) return true;
  return false;
}

// src/shared/agent/parse-text-tool-calls.ts
var TOOL_CALL_BLOCK_RE = /<\s*tool_call\s*>([\s\S]*?)<\s*\/\s*tool_call\s*>/gi;
var FUNCTION_RE = /<\s*function\s*=\s*([^>\s]+)\s*>([\s\S]*?)(?:<\s*\/\s*function\s*>|(?=<\s*function\s*=)|(?=<\s*\/\s*tool_call\s*>))/gi;
var PARAMETER_RE = /<\s*parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;
var TOOL_NAME_ALIASES = {
  runshell: "run_shell",
  run_shell: "run_shell",
  readfile: "read_file",
  read_file: "read_file",
  listdir: "list_dir",
  list_dir: "list_dir",
  searchcode: "search_code",
  search_code: "search_code",
  searchcodebase: "search_codebase",
  search_codebase: "search_codebase",
  findfiles: "find_files",
  find_files: "find_files",
  writefile: "write_file",
  write_file: "write_file",
  gitstatus: "git_status",
  git_status: "git_status",
  gitdiff: "git_diff",
  git_diff: "git_diff",
  gitlog: "git_log",
  git_log: "git_log",
  explore: "explore"
};
function normalizeToolName(raw) {
  const key = raw.trim().toLowerCase().replace(/-/g, "_");
  return TOOL_NAME_ALIASES[key] ?? raw.trim();
}
function parseParameters(body) {
  const args = {};
  for (const match of body.matchAll(PARAMETER_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;
    args[name] = (match[2] ?? "").trim();
  }
  return args;
}
function coerceStringlyTypedToolArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    const t = value.trim();
    if (t === "true") out[key] = true;
    else if (t === "false") out[key] = false;
    else if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
      const n = Number(t);
      out[key] = Number.isFinite(n) ? n : value;
    } else out[key] = value;
  }
  return out;
}
function parseFunctionsInBlock(inner, coerceToolArgs) {
  const toolCalls = [];
  for (const match of inner.matchAll(FUNCTION_RE)) {
    const name = normalizeToolName(match[1] ?? "");
    if (!name) continue;
    const coerced = coerceStringlyTypedToolArgs(parseParameters(match[2] ?? ""));
    const args = coerceToolArgs ? coerceToolArgs(name, coerced) : coerced;
    if (coerceToolArgs && args === null) continue;
    toolCalls.push({
      id: globalThis.crypto.randomUUID(),
      name,
      args: args ?? coerced
    });
  }
  return toolCalls;
}
function stripTextToolCallBlocks(text) {
  return text.replace(TOOL_CALL_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}
function recoverTextToolCalls(text, coerceToolArgs) {
  const toolCalls = [];
  let sawToolCallBlock = false;
  let anyBlockUnparsed = false;
  for (const match of text.matchAll(TOOL_CALL_BLOCK_RE)) {
    sawToolCallBlock = true;
    const inner = match[1];
    if (!inner?.trim()) {
      anyBlockUnparsed = true;
      continue;
    }
    const fromBlock = parseFunctionsInBlock(inner, coerceToolArgs);
    if (fromBlock.length === 0) anyBlockUnparsed = true;
    toolCalls.push(...fromBlock);
  }
  const keptRawBlocks = sawToolCallBlock && toolCalls.length === 0 && anyBlockUnparsed;
  return {
    cleanedText: keptRawBlocks ? text : stripTextToolCallBlocks(text),
    toolCalls,
    keptRawBlocks
  };
}

// src/shared/todos/todo-logic.ts
function hasOpenTodos(todos) {
  return todos.some((t) => t.status === "pending" || t.status === "in_progress");
}
var OPEN_TODOS_FINALIZE_NUDGE = "You still have open todos. Complete or cancel each pending/in_progress item with update_todos before finishing, or cancel items you will not do.";

// src/shared/agent/run-agent-loop.ts
var RECENT_FINGERPRINT_WINDOW = 16;
var TRIM_CRITICAL_FILL = 0.95;
var TRIM_DEFER_MAX_TOOL_STEPS = 2;
var FINALIZE_NUDGE = "Based on your exploration so far, write a clear final answer for the user. Do not call any tools.";
var INCOMPLETE_RUN_MESSAGE = "The agent stopped before producing a final answer. Try a shorter question, reduce tool use, or switch models.";
function emitStepUsage(getLastUsage, onChunk, usageModel) {
  const usage = getLastUsage?.();
  if (usage?.inputTokens) {
    setLastMeasuredInputTokens(usage.inputTokens);
  }
  if (usage && (usage.inputTokens || usage.outputTokens) && usageModel) {
    onChunk({
      type: "usage",
      model: usageModel,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens
    });
  }
}
function emitContextPressure(input, onChunk) {
  const pressure = measureConversationPressure(input);
  onChunk({
    type: "context_pressure",
    contextWindow: input.maxContextTokens,
    conversationBudget: pressure.conversationBudget,
    conversationTokens: pressure.conversationTokens,
    fillRatio: pressure.fillRatio
  });
}
async function streamTextOnlyTurn(provider, messages, onChunk, signal, nudge = FINALIZE_NUDGE, getLastUsage, usageModel) {
  const turnMessages = [...messages, { role: "user", content: nudge }];
  let assistantText = "";
  for await (const chunk of provider.stream(turnMessages, [], signal)) {
    if (signal?.aborted) break;
    if (chunk.type === "text") {
      assistantText += chunk.text;
      onChunk(chunk);
    }
    if (chunk.type === "done") break;
  }
  const trimmed = assistantText.trim();
  if (trimmed) {
    messages.push({ role: "assistant", content: assistantText });
  }
  emitStepUsage(getLastUsage, onChunk, usageModel);
  return trimmed;
}
async function runAgentLoop(opts) {
  setLastMeasuredInputTokens(null);
  const {
    provider,
    messages,
    tools,
    onChunk,
    signal,
    maxSteps = 20,
    maxContextTokens,
    toolSchemaReserveTokens = 0,
    onHistoryTrimmed,
    getLastUsage,
    usageModel,
    coerceTextToolCallArgs,
    getOpenTodos
  } = opts;
  let steps = 0;
  let finishedWithAnswer = false;
  let toolOnlySteps = 0;
  let loopNudgeSent = false;
  let forceTextAttempted = false;
  let trimEvents = 0;
  const recentFingerprints = [];
  while (steps < maxSteps) {
    if (signal?.aborted) break;
    steps++;
    repairToolUseToolResultPairing(messages);
    if (maxContextTokens) {
      const escalationInput = {
        messages,
        maxContextTokens,
        toolSchemaReserveTokens,
        toolOnlySteps,
        trimEvents
      };
      const pressure = measureConversationPressure(escalationInput);
      if (!finishedWithAnswer && !forceTextAttempted && shouldForceTextAnswer(escalationInput, pressure)) {
        forceTextAttempted = true;
        const forced = await streamTextOnlyTurn(
          provider,
          messages,
          onChunk,
          signal,
          STUCK_FINALIZE_NUDGE,
          getLastUsage,
          usageModel
        );
        if (forced.trim()) {
          finishedWithAnswer = true;
          break;
        }
      }
      if (!loopNudgeSent && shouldInjectLoopNudge(escalationInput, pressure)) {
        messages.push({ role: "user", content: LOOP_NUDGE_USER_MESSAGE });
        loopNudgeSent = true;
      }
      const reserve = tools.length > 0 ? toolSchemaReserveTokens : 0;
      const skipSoftTrim = toolOnlySteps <= TRIM_DEFER_MAX_TOOL_STEPS && pressure.fillRatio < TRIM_CRITICAL_FILL;
      if (!skipSoftTrim && trimMessagesInPlace(messages, maxContextTokens, { reserveTokens: reserve })) {
        trimEvents++;
        onHistoryTrimmed?.();
      }
    }
    let assistantText = "";
    const pendingToolCalls = [];
    for await (const chunk of provider.stream(messages, tools, signal)) {
      if (signal?.aborted) break;
      if (chunk.type === "text") {
        assistantText += chunk.text;
        onChunk(chunk);
      }
      if (chunk.type === "tool_call") {
        pendingToolCalls.push(chunk.toolCall);
        onChunk(chunk);
      }
      if (chunk.type === "done") break;
    }
    emitStepUsage(getLastUsage, onChunk, usageModel);
    if (maxContextTokens) {
      emitContextPressure(
        {
          messages,
          maxContextTokens,
          toolSchemaReserveTokens,
          toolOnlySteps,
          trimEvents
        },
        onChunk
      );
    }
    if (signal?.aborted) break;
    if (pendingToolCalls.length === 0 && /<\s*tool_call\s*>/i.test(assistantText)) {
      const recovered = recoverTextToolCalls(assistantText, coerceTextToolCallArgs);
      if (recovered.toolCalls.length > 0) {
        assistantText = recovered.cleanedText;
        onChunk({ type: "text_replace", text: assistantText });
        for (const tc of recovered.toolCalls) {
          pendingToolCalls.push(tc);
          onChunk({ type: "tool_call", toolCall: tc });
        }
      } else if (!recovered.keptRawBlocks) {
        assistantText = recovered.cleanedText;
        onChunk({ type: "text_replace", text: assistantText });
      }
    }
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: pendingToolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args }))
      });
    } else if (assistantText.trim()) {
      messages.push({ role: "assistant", content: assistantText });
      finishedWithAnswer = true;
      break;
    } else {
      continue;
    }
    const toolResults = [];
    for (let ti = 0; ti < pendingToolCalls.length; ti++) {
      const tc = pendingToolCalls[ti];
      if (!tc) continue;
      if (signal?.aborted) {
        for (let j = ti; j < pendingToolCalls.length; j++) {
          const cancelled = pendingToolCalls[j];
          if (!cancelled) continue;
          toolResults.push({ toolCallId: cancelled.id, result: CANCELLED_TOOL_RESULT });
          onChunk({
            type: "tool_result",
            toolCallId: cancelled.id,
            result: CANCELLED_TOOL_RESULT,
            isError: true
          });
        }
        break;
      }
      const normalizedArgs = normalizeExploreArgs(tc.name, tc.args);
      const fp = toolCallFingerprint(tc.name, normalizedArgs);
      const duplicate = isDuplicateExploreCall(tc.name, normalizedArgs, recentFingerprints);
      recentFingerprints.push(fp);
      if (recentFingerprints.length > RECENT_FINGERPRINT_WINDOW) {
        recentFingerprints.shift();
      }
      try {
        const result = duplicate ? DUPLICATE_TOOL_RESULT_PREFIX : await opts.executeTool(
          tc.name,
          normalizedArgs,
          signal ?? new AbortController().signal,
          tc.id
        );
        toolResults.push({ toolCallId: tc.id, result });
        onChunk({ type: "tool_result", toolCallId: tc.id, result, isError: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolResults.push({ toolCallId: tc.id, result: `Error: ${msg}` });
        onChunk({ type: "tool_result", toolCallId: tc.id, result: `Error: ${msg}`, isError: true });
      }
    }
    toolOnlySteps++;
    if (toolResults.length > 0) {
      messages.push({ role: "tool", toolResults });
    }
    if (signal?.aborted) break;
  }
  if (!signal?.aborted && !finishedWithAnswer) {
    const openTodos = getOpenTodos?.() ?? [];
    const nudge = openTodos.length > 0 && hasOpenTodos(openTodos) ? OPEN_TODOS_FINALIZE_NUDGE : FINALIZE_NUDGE;
    const finalText = await streamTextOnlyTurn(
      provider,
      messages,
      onChunk,
      signal,
      nudge,
      getLastUsage,
      usageModel
    );
    if (!finalText.trim()) {
      onChunk({ type: "text", text: INCOMPLETE_RUN_MESSAGE });
      messages.push({ role: "assistant", content: INCOMPLETE_RUN_MESSAGE });
    } else {
      finishedWithAnswer = true;
    }
  }
  onChunk({ type: "done" });
}

// src/shared/agent/run-agent-loop.test.ts
function mockProvider(chunks) {
  let call = 0;
  return {
    async *stream() {
      for (const chunk of chunks[call++ % chunks.length]) yield chunk;
    }
  };
}
(0, import_node_test.describe)("runAgentLoop", () => {
  (0, import_node_test.it)("emits done after text-only response", async () => {
    const chunks = [];
    await runAgentLoop({
      provider: mockProvider([[{ type: "text", text: "hi" }, { type: "done" }]]),
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async (_name, _args, _signal, _toolCallId) => ""
    });
    import_strict.default.equal(chunks.at(-1)?.type, "done");
  });
  (0, import_node_test.it)("respects AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();
    const chunks = [];
    await runAgentLoop({
      provider: mockProvider([[{ type: "text", text: "hi" }, { type: "done" }]]),
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async (_name, _args, _signal, _toolCallId) => "",
      signal: controller.signal
    });
    import_strict.default.equal(chunks.length, 1);
  });
  (0, import_node_test.it)("executes tools and adds tool_result chunks", async () => {
    let executed = false;
    const chunks = [];
    await runAgentLoop({
      provider: mockProvider([
        [{ type: "tool_call", toolCall: { id: "1", name: "test", args: {} } }, { type: "done" }],
        [{ type: "text", text: "done" }, { type: "done" }]
      ]),
      messages: [{ role: "user", content: "go" }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async (_name, _args, _signal, _toolCallId) => {
        executed = true;
        return "result";
      }
    });
    import_strict.default.ok(executed);
    import_strict.default.ok(chunks.some((c) => c.type === "tool_result"));
  });
  (0, import_node_test.it)("stops after maxSteps", async () => {
    let steps = 0;
    await runAgentLoop({
      provider: mockProvider([
        [{ type: "tool_call", toolCall: { id: "1", name: "loop", args: {} } }, { type: "done" }]
      ]),
      messages: [{ role: "user", content: "go" }],
      tools: [],
      maxSteps: 3,
      onChunk: () => {
      },
      executeTool: async (_name, _args, _signal, _toolCallId) => {
        steps++;
        return "ok";
      }
    });
    import_strict.default.ok(steps <= 3);
  });
  (0, import_node_test.it)("emits a final text answer after maxSteps tool-only loop", async () => {
    const chunks = [];
    await runAgentLoop({
      provider: mockProvider([
        [{ type: "tool_call", toolCall: { id: "1", name: "loop", args: {} } }, { type: "done" }],
        [{ type: "tool_call", toolCall: { id: "2", name: "loop", args: {} } }, { type: "done" }],
        [{ type: "text", text: "Here is the repo review." }, { type: "done" }]
      ]),
      messages: [{ role: "user", content: "review the repo" }],
      tools: [],
      maxSteps: 2,
      onChunk: (c) => chunks.push(c),
      executeTool: async (_name, _args, _signal, _toolCallId) => "ok"
    });
    import_strict.default.ok(chunks.some((c) => c.type === "text" && c.text.includes("repo review")));
    import_strict.default.equal(chunks.at(-1)?.type, "done");
  });
  (0, import_node_test.it)("skips duplicate explore tool execution", async () => {
    let executeCount = 0;
    await runAgentLoop({
      provider: mockProvider([
        [
          { type: "tool_call", toolCall: { id: "1", name: "list_dir", args: { path: "." } } },
          { type: "done" }
        ],
        [
          { type: "tool_call", toolCall: { id: "2", name: "list_dir", args: { path: "." } } },
          { type: "done" }
        ],
        [{ type: "text", text: "Done." }, { type: "done" }]
      ]),
      messages: [{ role: "user", content: "review" }],
      tools: [],
      onChunk: () => {
      },
      executeTool: async (_name, _args, _signal, _toolCallId) => {
        executeCount++;
        return "listing";
      }
    });
    import_strict.default.equal(executeCount, 1);
  });
  (0, import_node_test.it)("recovers embedded Cursor-style text tool calls", async () => {
    let executedName = "";
    const embedded = `Checking lint.

<tool_call>
<function=run_shell>
<parameter=command>npm run lint</parameter>
</function>
</tool_call>`;
    const chunks = [];
    await runAgentLoop({
      provider: mockProvider([
        [{ type: "text", text: embedded }, { type: "done" }],
        [{ type: "text", text: "All good." }, { type: "done" }]
      ]),
      messages: [{ role: "user", content: "lint" }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async (name, _args, _signal) => {
        executedName = name;
        return "lint ok";
      }
    });
    import_strict.default.equal(executedName, "run_shell");
    import_strict.default.ok(chunks.some((c) => c.type === "text_replace"));
    import_strict.default.ok(chunks.some((c) => c.type === "tool_result"));
  });
  (0, import_node_test.it)("surfaces a terminal message when finalize returns empty", async () => {
    const chunks = [];
    await runAgentLoop({
      provider: mockProvider([[{ type: "done" }], [{ type: "done" }]]),
      messages: [{ role: "user", content: "review the repo" }],
      tools: [],
      onChunk: (c) => chunks.push(c),
      executeTool: async (_name, _args, _signal, _toolCallId) => ""
    });
    import_strict.default.ok(
      chunks.some(
        (c) => c.type === "text" && c.text.includes("stopped before producing a final answer")
      )
    );
  });
  (0, import_node_test.it)("adds cancelled tool results when aborted mid-batch", async () => {
    const controller = new AbortController();
    const messages = [{ role: "user", content: "go" }];
    const chunks = [];
    await runAgentLoop({
      provider: mockProvider([
        [
          { type: "tool_call", toolCall: { id: "1", name: "a", args: {} } },
          { type: "tool_call", toolCall: { id: "2", name: "b", args: {} } },
          { type: "done" }
        ]
      ]),
      messages: [...messages],
      tools: [],
      onChunk: (c) => chunks.push(c),
      signal: controller.signal,
      executeTool: async (_name, _args, _signal, id) => {
        if (id === "1") {
          controller.abort();
          return "ok";
        }
        return "never";
      }
    });
    const cancelled = chunks.filter(
      (c) => c.type === "tool_result" && c.result.includes("cancelled")
    );
    import_strict.default.equal(cancelled.length, 1);
  });
  (0, import_node_test.it)("nudges to close open todos before finalize", async () => {
    const chunks = [];
    let nudgeText = "";
    const provider = {
      async *stream(messages) {
        const last = messages.at(-1);
        if (last && "content" in last && typeof last.content === "string" && last.content.includes("open todos")) {
          nudgeText = last.content;
          yield { type: "text", text: "All todos done." };
        }
        yield { type: "done" };
      }
    };
    await runAgentLoop({
      provider,
      messages: [{ role: "user", content: "big task" }],
      tools: [],
      maxSteps: 1,
      getOpenTodos: () => [{ id: "1", content: "Pending step", status: "pending" }],
      onChunk: (c) => chunks.push(c),
      executeTool: async () => ""
    });
    import_strict.default.match(nudgeText, /open todos/);
    import_strict.default.ok(chunks.some((c) => c.type === "text" && c.text.includes("All todos done")));
  });
});
