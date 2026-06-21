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

// src/shared/llm/mock-provider.test.ts
var import_node_test = require("node:test");
var import_strict = __toESM(require("node:assert/strict"));

// src/shared/llm/mock-provider.ts
var randomUUID = () => globalThis.crypto.randomUUID();
var MockLLMProvider = class {
  lastUsage = { inputTokens: 120, outputTokens: 80 };
  async *stream(messages, tools, signal) {
    const systemText = messages.filter((m) => m.role === "system").map((m) => typeof m.content === "string" ? m.content : "").join("\n");
    const demoSkillLoaded = systemText.includes('<skill_content name="demo-skill">');
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const fullUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
    const userText = fullUserText ? fullUserText.slice(0, 40) : "(complex input)";
    const text = demoSkillLoaded ? "Demo skill active \u2014 Copse skills support is working." : `Mock response to: ${userText}`;
    const isFirstTurn = messages.filter((m) => m.role === "assistant").length === 0;
    if (isFirstTurn && !demoSkillLoaded) {
      const directive = fullUserText.match(/\[\[mcp:([^\s\]]+)(\s+\{[^]*?\})?\]\]/);
      if (directive && tools.some((t) => t.name === directive[1])) {
        if (signal?.aborted) return;
        let args = {};
        if (directive[2]) {
          try {
            args = JSON.parse(directive[2].trim());
          } catch {
            args = {};
          }
        }
        yield { type: "tool_call", toolCall: { id: randomUUID(), name: directive[1], args } };
        yield { type: "done" };
        return;
      }
    }
    if (tools.length > 0 && isFirstTurn && !demoSkillLoaded) {
      if (signal?.aborted) return;
      const explore = tools.find((t) => t.name === "explore");
      const listDir = tools.find((t) => t.name === "list_dir");
      const toolCall = explore ? { id: randomUUID(), name: "explore", args: { query: "List the workspace root" } } : listDir ? { id: randomUUID(), name: "list_dir", args: { path: "." } } : { id: randomUUID(), name: tools[0].name, args: {} };
      yield { type: "tool_call", toolCall };
      yield { type: "done" };
      return;
    }
    for (const char of text) {
      if (signal?.aborted) return;
      yield { type: "text", text: char };
      await new Promise((r) => setTimeout(r, 10));
    }
    yield { type: "done" };
  }
};

// src/shared/llm/mock-provider.test.ts
async function collectChunks(provider, messages, tools) {
  const chunks = [];
  for await (const chunk of provider.stream(messages, tools)) {
    chunks.push(chunk);
  }
  return chunks;
}
(0, import_node_test.describe)("MockLLMProvider", () => {
  (0, import_node_test.it)("issues a tool call on the first assistant turn when tools exist", async () => {
    const provider = new MockLLMProvider();
    const tools = [{ name: "list_dir", description: "list", parameters: {} }];
    const chunks = await collectChunks(
      provider,
      [{ role: "user", content: "hello workspace" }],
      tools
    );
    import_strict.default.ok(chunks.some((c) => c.type === "tool_call" && c.toolCall.name === "list_dir"));
    import_strict.default.equal(chunks.at(-1)?.type, "done");
  });
  (0, import_node_test.it)("returns mock text on later turns without another tool call", async () => {
    const provider = new MockLLMProvider();
    const tools = [{ name: "list_dir", description: "list", parameters: {} }];
    const messages = [
      { role: "user", content: "hello workspace" },
      { role: "assistant", content: [{ id: "1", name: "list_dir", args: { path: "." } }] },
      { role: "tool", toolResults: [{ toolCallId: "1", result: "ok" }] }
    ];
    const chunks = await collectChunks(provider, messages, tools);
    const text = chunks.filter((c) => c.type === "text").map((c) => c.text).join("");
    import_strict.default.match(text, /Mock response to:/);
    import_strict.default.ok(!chunks.some((c) => c.type === "tool_call"));
  });
});
