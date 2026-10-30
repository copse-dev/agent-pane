import {
  ACP_CANCELLED_TOOL_CALL_RESULT,
  ADVISOR_MODEL_SETTING_ID,
  ADVISOR_STRATEGY_PLUGIN_ID,
  ADVISOR_STRATEGY_TOOL_NAME,
  AUTOMATIONS_PLUGIN_ID,
  CHARS_PER_TOKEN,
  DEFAULT_ADVISOR_MODEL_ID,
  PRODUCT_ANNOUNCEMENTS,
  ThreadPrRelationshipIndex,
  backlinksFor,
  detectLanguage,
  emptyContainerStorage,
  external_exports,
  firstPartyProviderOf,
  init_advisor_strategy_plugin,
  init_announcement_catalog,
  init_automations_plugin,
  init_files,
  init_model_capabilities,
  init_model_parameters,
  init_product_announcement_dialog,
  init_product_announcements,
  init_settings_dialog,
  init_storage_cleanup,
  init_thread_links2 as init_thread_links,
  init_thread_pr_relations,
  init_token_estimate,
  init_tool_interruption,
  init_working_brief,
  init_zod,
  isReasoningLevel,
  mountProductAnnouncements,
  openSettingsDialog,
  useAnnouncementCatalog,
  workingBriefFromUserContent
} from "./chunks/chunk-SKPO4FJB.js";
import "./chunks/chunk-D55J6ZRP.js";
import {
  init_icons,
  init_unknown_value,
  init_unknown_value3 as init_unknown_value2,
  isRecord,
  maximizeIcon,
  minimizeIcon,
  stringRecordOrEmpty
} from "./chunks/chunk-HZHR2CRE.js";
import "./chunks/chunk-EMIRHVRH.js";
import {
  __commonJS,
  __esm
} from "./chunks/chunk-WW3EXSJD.js";

// src/renderer/demo/announcement-fixtures.ts
var DEMO_PRODUCT_ANNOUNCEMENTS;
var init_announcement_fixtures = __esm({
  "src/renderer/demo/announcement-fixtures.ts"() {
    DEMO_PRODUCT_ANNOUNCEMENTS = [
      {
        id: "demo-compact-released",
        title: "Compact is now the default",
        message: "Compact view is out of experimental and available to everyone. Chats now have a more concise, focused layout.",
        detail: "Prefer another view? Change it anytime in Settings \u2192 Appearance.",
        settingsAction: { label: "Appearance settings", section: "appearance" }
      },
      {
        id: "demo-announcements-ready",
        title: "Stay up to date",
        message: "When a change affects how you use Copse, you\u2019ll see a short announcement here.",
        detail: "Dismiss it once and carry on with your work."
      }
    ];
  }
});

// src/renderer/demo/demo.css
var init_demo = __esm({
  "src/renderer/demo/demo.css"() {
  }
});

// packages/agent/src/parse-agent-run-payload.ts
function parseReviewContext(value) {
  if (typeof value !== "string" || value.trim() === "") return void 0;
  return value.length <= REVIEW_CONTEXT_CHAR_CAP ? value : `${value.slice(0, REVIEW_CONTEXT_CHAR_CAP)}
[review summary truncated]`;
}
function parseAgentRunPayload(rawPrompt) {
  try {
    const parsed = JSON.parse(rawPrompt);
    if (isRecord(parsed) && "content" in parsed) {
      const content2 = userContentSchema.safeParse(parsed["content"]);
      if (!content2.success) {
        return { userContent: rawPrompt, invokedSkills: [], priorTodos: [] };
      }
      const invokedSkills = external_exports.array(external_exports.string()).safeParse(parsed["invokedSkills"]);
      const priorTodos = external_exports.array(todoSchema).safeParse(parsed["priorTodos"]);
      const reviewContext = parseReviewContext(parsed["reviewContext"]);
      const normalizedTodos = priorTodos.success ? priorTodos.data.map((todo) => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
        ...todo.check !== void 0 ? { check: todo.check } : {},
        ...todo.assignedModel !== void 0 ? { assignedModel: todo.assignedModel } : {}
      })) : [];
      return {
        userContent: content2.data,
        ...parsed["automationRun"] === true ? { automationRun: true } : {},
        ...parsed["executionMode"] === "agent" ? { executionMode: "agent" } : {},
        invokedSkills: invokedSkills.success ? invokedSkills.data : [],
        priorTodos: normalizedTodos,
        ...typeof parsed["invokedAgent"] === "string" && parsed["invokedAgent"] ? { invokedAgent: parsed["invokedAgent"] } : {},
        ...typeof parsed["workingBrief"] === "string" ? { workingBrief: parsed["workingBrief"] } : {},
        ...typeof parsed["model"] === "string" && parsed["model"] ? { model: parsed["model"] } : {},
        ...isReasoningLevel(parsed["reasoning"]) ? { reasoning: parsed["reasoning"] } : {},
        ...typeof parsed["turnTreeId"] === "string" && parsed["turnTreeId"] ? { turnTreeId: parsed["turnTreeId"] } : {},
        ...typeof parsed["continuationBudgetUsed"] === "number" && Number.isFinite(parsed["continuationBudgetUsed"]) ? { continuationBudgetUsed: parsed["continuationBudgetUsed"] } : {},
        ...reviewContext !== void 0 ? { reviewContext } : {}
      };
    }
    const content = userContentSchema.safeParse(parsed);
    return {
      userContent: content.success ? content.data : rawPrompt,
      invokedSkills: [],
      priorTodos: []
    };
  } catch {
    return { userContent: rawPrompt, invokedSkills: [], priorTodos: [] };
  }
}
var userContentSchema, todoSchema, REVIEW_CONTEXT_CHAR_CAP;
var init_parse_agent_run_payload = __esm({
  "packages/agent/src/parse-agent-run-payload.ts"() {
    init_model_parameters();
    init_zod();
    init_unknown_value();
    userContentSchema = external_exports.union([
      external_exports.string(),
      external_exports.array(
        external_exports.discriminatedUnion("type", [
          external_exports.object({ type: external_exports.literal("text"), text: external_exports.string() }),
          external_exports.object({ type: external_exports.literal("image"), dataUrl: external_exports.string() })
        ])
      )
    ]);
    todoSchema = external_exports.object({
      id: external_exports.string(),
      content: external_exports.string(),
      status: external_exports.enum(["pending", "in_progress", "completed", "cancelled"]),
      priority: external_exports.enum(["high", "medium", "low"]).optional(),
      check: external_exports.discriminatedUnion("kind", [
        external_exports.object({
          kind: external_exports.literal("shell"),
          command: external_exports.string(),
          expectExit: external_exports.number().optional()
        }),
        external_exports.object({ kind: external_exports.literal("fileExists"), path: external_exports.string() }),
        external_exports.object({ kind: external_exports.literal("typecheck") })
      ]).optional(),
      assignedModel: external_exports.enum(["cloud", "local"]).optional()
    });
    REVIEW_CONTEXT_CHAR_CAP = 2e4;
  }
});

// src/renderer/demo/trace-player.ts
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function sliceForStreaming(text, sliceChars) {
  if (text === "") return [];
  const slices = [];
  let index = 0;
  while (index < text.length) {
    let end = Math.min(index + sliceChars, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > index) end = boundary + 1;
    }
    slices.push(text.slice(index, end));
    index = end;
  }
  return slices;
}
async function playTrace(trace, emit, options = {}) {
  const {
    charsPerSecond = DEFAULT_CHARS_PER_SECOND,
    sliceChars = DEFAULT_SLICE_CHARS,
    stepPauseMs = DEFAULT_STEP_PAUSE_MS,
    instant = false,
    signal,
    sleep: sleep2 = defaultSleep
  } = options;
  const pause = async (ms) => {
    if (instant || ms <= 0) return;
    await sleep2(ms);
  };
  const aborted = () => signal?.aborted === true;
  for (const step of trace.steps) {
    if (aborted()) return;
    await pause(step.delayMs ?? stepPauseMs);
    if (aborted()) return;
    const { chunk } = step;
    if (chunk.type === "text" || chunk.type === "reasoning") {
      for (const slice of sliceForStreaming(chunk.text, sliceChars)) {
        if (aborted()) return;
        emit({ type: chunk.type, text: slice });
        await pause(slice.length / charsPerSecond * 1e3);
      }
      continue;
    }
    emit(chunk);
  }
}
var DEFAULT_CHARS_PER_SECOND, DEFAULT_SLICE_CHARS, DEFAULT_STEP_PAUSE_MS;
var init_trace_player = __esm({
  "src/renderer/demo/trace-player.ts"() {
    DEFAULT_CHARS_PER_SECOND = 240;
    DEFAULT_SLICE_CHARS = 12;
    DEFAULT_STEP_PAUSE_MS = 260;
  }
});

// src/shared/demo-traces/landing.ts
var LANDING_TRACE;
var init_landing = __esm({
  "src/shared/demo-traces/landing.ts"() {
    LANDING_TRACE = {
      id: "landing",
      label: "Builds a cupcake site",
      prompt: "Build a polished coming-soon site for Crumb & Bloom, a playful premium cupcake studio. Include email signup, make it feel handcrafted, and preview it when done.",
      steps: [
        {
          chunk: {
            type: "reasoning",
            text: "\n\n**Planning commentary before editing**\n\n**Inspecting list and status with parallel exec**"
          }
        },
        {
          chunk: {
            type: "text",
            text: "I\u2019ll first inspect the project structure and any existing assets, then I\u2019ll build the page in the project\u2019s native setup. Visual direction: warm patisserie editorial\u2014vanilla paper, berry ink, hand-drawn flourishes, oversized type, and a signup interaction that feels like part of the composition rather than a generic form. Afterward I\u2019ll test responsiveness and behavior, then open a browser preview."
          }
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-798b76ff-4aef-4927-a7ef-d7465b5dd9a9",
              name: "git_status",
              args: {},
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-798b76ff-4aef-4927-a7ef-d7465b5dd9a9",
            result: "(no output)",
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-eab41b0d-9d5b-4803-99ca-c4fa777171a4",
              name: "list_dir",
              args: {
                path: ".",
                recursive: true
              },
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-eab41b0d-9d5b-4803-99ca-c4fa777171a4",
            result: "",
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "reasoning",
            text: "\n\n**Creating SVG cupcake illustration files**"
          }
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-c3d1f576-7b42-4380-a915-d5a3d77fd339",
              name: "write_file",
              args: {
                path: "index.html",
                content: '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <meta name="description" content="Crumb & Bloom \u2014 small-batch cupcakes, thoughtfully made. Join the first-bite list.">\n  <title>Crumb & Bloom \u2014 Coming Soon</title>\n  <link rel="preconnect" href="https://fonts.googleapis.com">\n  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n  <div class="page-shell">\n    <header class="site-header">\n      <a class="brand" href="#" aria-label="Crumb and Bloom home">\n        <span class="brand-mark" aria-hidden="true">C<span>&</span>B</span>\n        <span class="brand-name">Crumb <em>&</em> Bloom</span>\n      </a>\n      <div class="header-note"><span></span> Whisking up something lovely</div>\n    </header>\n\n    <main>\n      <section class="hero" aria-labelledby="hero-title">\n        <div class="hero-copy">\n          <p class="eyebrow">A small-batch cupcake studio</p>\n          <h1 id="hero-title">Little cakes.<br><em>Big feelings.</em></h1>\n          <p class="intro">Playful flavours, cloud-soft swirls, and the kind of crumbs worth getting on your best shirt.</p>\n\n          <form class="signup" id="signup-form">\n            <label for="email">Join the first-bite list</label>\n            <div class="form-row">\n              <input id="email" name="email" type="email" placeholder="your@email.com" autocomplete="email" required>\n              <button type="submit"><span>Save me a spot</span><span aria-hidden="true">\u2197</span></button>\n            </div>\n            <p class="form-note" id="form-note" aria-live="polite">Fresh drops, opening news & no soggy inboxes.</p>\n          </form>\n        </div>\n\n        <div class="hero-art" aria-label="Illustration of a cherry-topped cupcake">\n          <span class="doodle doodle-one" aria-hidden="true">\u2726</span>\n          <span class="doodle doodle-two" aria-hidden="true">made<br>with joy</span>\n          <svg class="cupcake" viewBox="0 0 560 600" role="img" aria-labelledby="cupcake-title">\n            <title id="cupcake-title">A hand-drawn pink cupcake topped with a cherry</title>\n            <path class="shadow" d="M108 534c62 35 275 39 340-4 42-28-24-55-164-56-136-1-219 35-176 60z"/>\n            <path class="wrapper" d="M140 318l32 216c4 26 27 43 53 43h116c25 0 47-17 52-42l37-217z"/>\n            <path class="wrapper-line" d="M181 337l28 207M237 332l10 231M294 332l-1 231M350 332l-18 229M403 334l-43 211"/>\n            <path class="frosting" d="M126 329c-22-25 0-62 39-71-11-35 13-69 59-72-4-39 30-69 73-60 29-32 84-21 92 21 42-4 68 32 59 70 42 10 55 52 29 79 16 23 1 53-30 54l-291 1c-27 0-44-10-30-22z"/>\n            <path class="frosting-detail" d="M169 257c24-4 43 3 54 20M223 186c24 3 40 16 44 35M296 129c20 8 30 23 28 44M390 149c-19 7-30 21-30 41M447 219c-24-3-43 7-53 26M143 310c33-15 62-11 83 8M286 218c-26 9-37 31-32 53M345 280c17-25 40-34 69-25"/>\n            <path class="stem" d="M322 134c3-52 32-87 81-103"/>\n            <path class="leaf" d="M358 71c25-42 65-43 85-34-13 34-43 51-85 34z"/>\n            <circle class="cherry" cx="312" cy="126" r="43"/>\n            <path class="cherry-shine" d="M290 106c6-9 14-13 25-14"/>\n          </svg>\n          <p class="art-caption"><span>01</span> Signature swirls<br>in every season</p>\n        </div>\n      </section>\n\n      <section class="ticker" aria-label="What to expect">\n        <div class="ticker-track">\n          <span>Small batches</span><i>\u273F</i><span>Big buttercream</span><i>\u273F</i><span>Joyful flavours</span><i>\u273F</i>\n          <span aria-hidden="true">Small batches</span><i aria-hidden="true">\u273F</i><span aria-hidden="true">Big buttercream</span><i aria-hidden="true">\u273F</i><span aria-hidden="true">Joyful flavours</span><i aria-hidden="true">\u273F</i>\n        </div>\n      </section>\n    </main>\n\n    <footer>\n      <p>Baked with care in London</p>\n      <p>Opening autumn 2026</p>\n      <a href="https://www.instagram.com" aria-label="Follow Crumb and Bloom on Instagram">Instagram \u2197</a>\n    </footer>\n  </div>\n  <script src="script.js"><\/script>\n</body>\n</html>'
              },
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-c3d1f576-7b42-4380-a915-d5a3d77fd339",
            result: "Applied edit directly to index.html. Git was clean except for Copse-applied edits in this session, so no approval was required. You can validate with run_shell/read_file/git now.",
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-93ee42b7-5aa3-4f60-bc0d-742ecb190338",
              name: "write_file",
              args: {
                path: "styles.css",
                content: `:root {
  --cream: #f6f0e3;
  --paper: #fffaf0;
  --berry: #8d2341;
  --pink: #e9a6b8;
  --pink-light: #f5cbd3;
  --red: #c9314b;
  --green: #3d684d;
  --ink: #2d251f;
  --line: rgba(45, 37, 31, .25);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--cream);
  color: var(--ink);
  font-family: "DM Sans", sans-serif;
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: "";
  position: fixed; inset: 0; pointer-events: none; opacity: .32;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.08'/%3E%3C/svg%3E");
  z-index: 10;
}
.page-shell { min-height: 100vh; overflow: hidden; }
.site-header {
  height: 100px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 clamp(24px, 5vw, 76px); border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 13px; color: inherit; text-decoration: none; }
.brand-mark {
  width: 44px; height: 44px; border: 1.5px solid var(--ink); border-radius: 50%;
  display: grid; place-items: center; font-family: "Instrument Serif"; font-size: 17px;
  transform: rotate(-5deg);
}
.brand-mark span, .brand-name em { color: var(--berry); font-style: italic; }
.brand-name { font-family: "Instrument Serif"; font-size: 25px; letter-spacing: -.02em; }
.header-note { text-transform: uppercase; font-size: 10px; letter-spacing: .17em; display: flex; align-items: center; gap: 10px; }
.header-note span { width: 7px; height: 7px; background: var(--red); border-radius: 50%; animation: pulse 2s infinite; }

.hero {
  min-height: calc(100vh - 182px); display: grid; grid-template-columns: minmax(0, 1.04fr) minmax(420px, .96fr);
}
.hero-copy {
  padding: clamp(70px, 8vw, 125px) clamp(30px, 7.5vw, 118px) 74px;
  display: flex; flex-direction: column; justify-content: center; border-right: 1px solid var(--line);
}
.eyebrow {
  margin: 0 0 25px; color: var(--berry); text-transform: uppercase; letter-spacing: .19em;
  font-size: 11px; font-weight: 600; display: flex; gap: 12px; align-items: center;
}
.eyebrow::before { content:""; width: 32px; height: 1px; background: currentColor; }
h1 { margin: 0; font-family: "Instrument Serif"; font-weight: 400; font-size: clamp(68px, 7.3vw, 116px); line-height: .83; letter-spacing: -.055em; }
h1 em { color: var(--berry); font-weight: 400; }
.intro { max-width: 470px; margin: 35px 0 47px; font-family: "Instrument Serif"; font-size: clamp(20px, 1.7vw, 25px); line-height: 1.4; }
.signup { max-width: 555px; }
.signup label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .14em; font-weight: 600; margin-bottom: 11px; }
.form-row { display: flex; border-bottom: 1.5px solid var(--ink); }
input {
  min-width: 0; flex: 1; border: 0; background: transparent; padding: 14px 4px;
  font: 17px "DM Sans"; color: var(--ink); outline: none;
}
input::placeholder { color: #7b7169; }
button {
  border: 0; background: var(--berry); color: white; font: 600 11px "DM Sans";
  text-transform: uppercase; letter-spacing: .1em; padding: 0 18px; margin-bottom: 7px;
  display: flex; align-items: center; gap: 15px; cursor: pointer; transition: background .2s, transform .2s;
}
button:hover { background: var(--ink); transform: translateY(-2px); }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 3px solid var(--pink); outline-offset: 4px; }
.form-note { font-size: 11px; color: #746b63; margin: 10px 0 0; min-height: 16px; }
.form-note.success { color: var(--green); font-weight: 600; }

.hero-art { position: relative; display: grid; place-items: center; background: var(--pink-light); min-height: 660px; }
.hero-art::before {
  content:""; position: absolute; width: min(76%, 530px); aspect-ratio: 1;
  border: 1px solid rgba(141,35,65,.24); border-radius: 50%;
}
.cupcake { width: min(78%, 580px); position: relative; filter: drop-shadow(0 16px 0 rgba(141,35,65,.08)); animation: float 5s ease-in-out infinite; }
.shadow { fill: #cd889b; opacity: .45; }
.wrapper { fill: #f3d58f; stroke: var(--ink); stroke-width: 3; stroke-linejoin: round; }
.wrapper-line { fill: none; stroke: #bb8647; stroke-width: 2.2; opacity: .65; }
.frosting { fill: #fff9ee; stroke: var(--ink); stroke-width: 3.4; stroke-linejoin: round; }
.frosting-detail { fill: none; stroke: #d795a8; stroke-width: 3; stroke-linecap: round; }
.stem { fill: none; stroke: var(--green); stroke-width: 7; stroke-linecap: round; }
.leaf { fill: #789b67; stroke: var(--ink); stroke-width: 3; }
.cherry { fill: var(--red); stroke: var(--ink); stroke-width: 3; }
.cherry-shine { fill: none; stroke: #ffd9da; stroke-width: 6; stroke-linecap: round; }
.doodle { position: absolute; z-index: 2; color: var(--berry); }
.doodle-one { font-size: 42px; top: 17%; right: 13%; transform: rotate(14deg); }
.doodle-two { left: 8%; top: 26%; font: italic 20px/1 "Instrument Serif"; text-align: center; transform: rotate(-11deg); }
.doodle-two::after { content: "\u2198"; display: block; font-size: 29px; margin: 7px 0 0 31px; }
.art-caption {
  position: absolute; right: 7%; bottom: 6%; margin: 0; font: italic 16px/1.25 "Instrument Serif";
  transform: rotate(3deg);
}
.art-caption span { font: 10px "DM Sans"; letter-spacing: .15em; display: block; margin-bottom: 5px; }

.ticker { background: var(--berry); color: var(--paper); overflow: hidden; padding: 15px 0; }
.ticker-track { width: max-content; display: flex; align-items: center; animation: ticker 28s linear infinite; }
.ticker span { font: italic 21px "Instrument Serif"; padding: 0 34px; }
.ticker i { font-style: normal; font-size: 14px; color: var(--pink); }
footer {
  min-height: 82px; padding: 0 clamp(24px, 5vw, 76px); display: flex; align-items: center; gap: 40px;
  text-transform: uppercase; letter-spacing: .12em; font-size: 9px;
}
footer p:nth-child(2) { margin-left: auto; }
footer a { color: inherit; text-underline-offset: 4px; }

@keyframes pulse { 50% { transform: scale(.65); opacity: .5; } }
@keyframes float { 50% { transform: translateY(-9px) rotate(1deg); } }
@keyframes ticker { to { transform: translateX(-50%); } }

@media (max-width: 860px) {
  .site-header { height: 82px; }
  .brand-name { font-size: 22px; }
  .header-note { display: none; }
  .hero { grid-template-columns: 1fr; }
  .hero-copy { border-right: 0; padding: 72px 25px 70px; }
  h1 { font-size: clamp(65px, 18vw, 94px); }
  .intro { margin: 30px 0 42px; }
  .hero-art { min-height: 570px; border-top: 1px solid var(--line); }
  .cupcake { width: min(87%, 520px); }
  footer { flex-wrap: wrap; justify-content: space-between; gap: 10px 20px; padding-block: 25px; }
  footer p { margin: 0; }
  footer p:nth-child(2) { margin-left: 0; }
}
@media (max-width: 480px) {
  .brand-mark { width: 38px; height: 38px; }
  h1 { font-size: 65px; }
  .form-row { display: block; border: 0; }
  input { width: 100%; border-bottom: 1.5px solid var(--ink); }
  button { width: 100%; height: 50px; margin: 12px 0 0; justify-content: space-between; }
  .hero-art { min-height: 470px; }
  .doodle-two { top: 16%; }
  .art-caption { bottom: 4%; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
}`
              },
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-93ee42b7-5aa3-4f60-bc0d-742ecb190338",
            result: "Applied edit directly to styles.css. Git was clean except for Copse-applied edits in this session, so no approval was required. You can validate with run_shell/read_file/git now.",
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-2e778c46-b3e5-46b5-9e86-7a643af2fdb5",
              name: "write_file",
              args: {
                path: "script.js",
                content: `const form = document.querySelector('#signup-form');
const note = document.querySelector('#form-note');
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const email = new FormData(form).get('email');
  if (!email) return;
  note.textContent = "You're on the list \u2014 we'll save you the first swirl.";
  note.classList.add('success');
  form.querySelector('button span:first-child').textContent = 'You\u2019re in!';
  form.querySelector('input').value = '';
});`
              },
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-2e778c46-b3e5-46b5-9e86-7a643af2fdb5",
            result: "Applied edit directly to script.js. Git was clean except for Copse-applied edits in this session, so no approval was required. You can validate with run_shell/read_file/git now.",
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "text",
            text: "The core page is in place: a split editorial hero, custom hand-drawn cupcake artwork, moving flavour ribbon, and a responsive signup flow. I\u2019m opening it now to check the actual rendered composition, keyboard-readable structure, and form behavior; I\u2019ll adjust anything that looks off in the browser."
          }
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-4e186036-cd38-4890-959e-556e67eeb55e",
              name: "browser_preview",
              args: {
                path: "index.html"
              },
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-4e186036-cd38-4890-959e-556e67eeb55e",
            result: "Opened tab-1 in the visible Browser panel: Crumb & Bloom \u2014 Coming Soon\nhttp://localhost:61025/index.html",
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "reasoning",
            text: "\n\n**Requesting screenshot**"
          }
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-d06a3ecf-21ee-4e84-98cd-59d0f0405a64",
              name: "browser_screenshot",
              args: {
                viewId: "tab-1"
              },
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-d06a3ecf-21ee-4e84-98cd-59d0f0405a64",
            result: 'Captured a 1280\xD7720 PNG of tab-1 \u2014 "Crumb & Bloom \u2014 Coming Soon".\nSource: http://localhost:61025/index.html\nCapture handle (thread-scoped and short-lived): capture_22222222-2222-4222-8222-222222222222\nThe screenshot is attached to this tool result.',
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-fa1cc6dd-5f45-4a2d-b3fa-1d9a42378200",
              name: "browser_snapshot",
              args: {
                viewId: "tab-1"
              },
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-fa1cc6dd-5f45-4a2d-b3fa-1d9a42378200",
            result: 'page: "Crumb & Bloom \u2014 Coming Soon"\nurl: http://localhost:61025/index.html\n\n- link "Crumb and Bloom home" [ref=e1]\n  - text "&" [ref=e2]\n  - text "&" [ref=e3]\n- text "A small-batch cupcake studio"\n- heading "Little cakes.Big feelings."\n  - text "Big feelings."\n- text "Playful flavours, cloud-soft swirls, and the kind of crumbs worth getting on your best shirt."\n- text "Join the first-bite list"\n- textbox "Join the first-bite list" [ref=e4]\n- button "Save me a spot\u2197" [ref=e5]\n  - text "Save me a spot" [ref=e6]\n  - text "\u2197" [ref=e7]\n- text "Fresh drops, opening news & no soggy inboxes."\n- text "\u2726"\n- img "A hand-drawn pink cupcake topped with a cherry"\n- text "01 Signature swirlsin every season"\n- text "01"\n- text "Small batches"\n- text "\u273F"\n- text "Big buttercream"\n- text "\u273F"\n- text "Joyful flavours"\n- text "\u273F"\n- text "Small batches"\n- text "\u273F"\n- text "Big buttercream"\n- text "\u273F"\n- text "Joyful flavours"\n- text "\u273F"\n- text "Baked with care in London"\n- text "Opening autumn 2026"\n- link "Follow Crumb and Bloom on Instagram" [ref=e8]',
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "reasoning",
            text: "\n\n**Testing image viewing via screenshot tool**"
          }
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-a5b1aaf5-9e63-4bf6-af9c-4bcea44ce7a1",
              name: "browser_type",
              args: {
                ref: "e4",
                text: "hello@example.com",
                viewId: "tab-1"
              },
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-a5b1aaf5-9e63-4bf6-af9c-4bcea44ce7a1",
            result: "Typed into [ref=e4]",
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-13b18f21-2291-416f-9ab7-89c7347892f4",
              name: "browser_click",
              args: {
                ref: "e5",
                viewId: "tab-1"
              },
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-13b18f21-2291-416f-9ab7-89c7347892f4",
            result: "Clicked [ref=e5]",
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "exec-1fe3e158-c75e-46b8-b140-e655e65e31eb",
              name: "browser_snapshot",
              args: {
                viewId: "tab-1"
              },
              kind: "execute"
            }
          },
          delayMs: 420
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "exec-1fe3e158-c75e-46b8-b140-e655e65e31eb",
            result: `page: "Crumb & Bloom \u2014 Coming Soon"
url: http://localhost:61025/index.html

- link "Crumb and Bloom home" [ref=e1]
  - text "&" [ref=e2]
  - text "&" [ref=e3]
- text "A small-batch cupcake studio"
- heading "Little cakes.Big feelings."
  - text "Big feelings."
- text "Playful flavours, cloud-soft swirls, and the kind of crumbs worth getting on your best shirt."
- text "Join the first-bite list"
- textbox "Join the first-bite list" [ref=e4]
- button "You\u2019re in!\u2197" [ref=e5]
  - text "You\u2019re in!" [ref=e6]
  - text "\u2197" [ref=e7]
- text "You're on the list \u2014 we'll save you the first swirl."
- text "\u2726"
- img "A hand-drawn pink cupcake topped with a cherry"
- text "01 Signature swirlsin every season"
- text "01"
- text "Small batches"
- text "\u273F"
- text "Big buttercream"
- text "\u273F"
- text "Joyful flavours"
- text "\u273F"
- text "Small batches"
- text "\u273F"
- text "Big buttercream"
- text "\u273F"
- text "Joyful flavours"
- text "\u273F"
- text "Baked with care in London"
- text "Opening autumn 2026"
- link "Follow Crumb and Bloom on Instagram" [ref=e8]`,
            isError: false,
            resultFormat: "markdown"
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "reasoning",
            text: "\n\n**Planning overflow validation approach**"
          }
        },
        {
          chunk: {
            type: "text",
            text: "Built and previewed a polished, responsive coming-soon site for Crumb & Bloom featuring:\n\n- Handcrafted cupcake illustration\n- Warm editorial branding and typography\n- Animated flavour ticker\n- Functional email signup confirmation\n- Accessible focus states and reduced-motion support\n- Mobile-responsive layout\n\nFiles: [index.html](~/index.html), [styles.css](~/styles.css), [script.js](~/script.js)\n\nhttp://localhost:61025/index.html"
          }
        },
        {
          chunk: {
            type: "usage",
            model: "acp:codex",
            inputTokens: 1236,
            outputTokens: 160,
            cacheReadTokens: 23296
          },
          delayMs: 300
        },
        {
          chunk: {
            type: "done",
            stopReason: "end_turn"
          },
          delayMs: 300
        }
      ],
      source: {
        exportVersion: 5,
        threadId: "44f88c10-9b17-4536-8314-646199f8936f",
        title: "Build a polished coming-soon site for",
        turn: 0,
        model: "acp:codex"
      }
    };
  }
});

// src/shared/demo-site-tour.ts
function earlierThreads(minutesAgo) {
  return [
    {
      id: "demo-site-tour-coming-soon",
      title: "Crumb & Bloom coming soon",
      status: "idle",
      gitBranch: "main",
      model: SITE_TOUR_MODEL,
      messages: [
        {
          id: "demo-site-tour-coming-soon-user",
          role: "user",
          content: "Build a polished coming-soon site for Crumb & Bloom, a playful premium cupcake studio.",
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - (minutesAgo + 240) * 6e4
        },
        {
          id: "demo-site-tour-coming-soon-assistant",
          role: "assistant",
          content: "Built the coming-soon page in `index.html`, `styles.css`, and `script.js`.",
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - (minutesAgo + 236) * 6e4
        }
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: SITE_TOUR_TIME - (minutesAgo + 240) * 6e4,
      updatedAt: SITE_TOUR_TIME - (minutesAgo + 236) * 6e4
    },
    {
      id: "demo-site-tour-menu-photos",
      title: "Compress the menu photos",
      status: "idle",
      gitBranch: "main",
      model: SITE_TOUR_MODEL,
      messages: [
        {
          id: "demo-site-tour-menu-photos-user",
          role: "user",
          content: "The menu photos are slow on mobile. Can you compress them?",
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - (minutesAgo + 90) * 6e4
        },
        {
          id: "demo-site-tour-menu-photos-assistant",
          role: "assistant",
          content: 'Converted the six menu photos to WebP and added `loading="lazy"`.',
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - (minutesAgo + 86) * 6e4
        }
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: SITE_TOUR_TIME - (minutesAgo + 90) * 6e4,
      updatedAt: SITE_TOUR_TIME - (minutesAgo + 86) * 6e4
    }
  ];
}
function siteTourScenario(id, label, thread, extra = {}) {
  return {
    id,
    label,
    project: CRUMB_AND_BLOOM,
    settings: SITE_TOUR_SETTINGS,
    threads: [thread, ...earlierThreads(30)],
    ...extra
  };
}
var SITE_TOUR_TIME, SITE_TOUR_MODEL, CRUMB_AND_BLOOM, SITE_TOUR_SETTINGS, SITE_TOUR_GITHUB_MCP, SITE_TOUR_TOOL_PERMISSIONS, SEASONAL_PR_BODY, SIGNUP_THREAD, SITE_TOUR_SCENARIOS;
var init_demo_site_tour = __esm({
  "src/shared/demo-site-tour.ts"() {
    SITE_TOUR_TIME = Date.UTC(2026, 8, 14, 10, 30, 0);
    SITE_TOUR_MODEL = "claude-opus-5-5";
    CRUMB_AND_BLOOM = {
      id: "demo-crumb-and-bloom",
      name: "Crumb & Bloom",
      path: "/demo/crumb-and-bloom"
    };
    SITE_TOUR_SETTINGS = {
      onboardingCompleted: true,
      theme: "dark",
      uiTintStrength: "off",
      model: SITE_TOUR_MODEL
    };
    SITE_TOUR_GITHUB_MCP = {
      name: "github",
      transport: "http",
      state: "connected",
      toolCount: 5,
      tools: [
        "search_issues",
        "get_pull_request",
        "create_issue",
        "add_issue_comment",
        "merge_pull_request"
      ],
      source: "/demo/crumb-and-bloom/.mcp.json",
      origin: "project",
      originDetail: ".mcp.json",
      userEnabled: true,
      configDisabled: false
    };
    SITE_TOUR_TOOL_PERMISSIONS = {
      groups: [
        {
          id: "copse",
          name: "Copse tools",
          kind: "copse",
          tools: [
            {
              id: "copse:read-file",
              executionName: "read_file",
              name: "Read file",
              description: "Read a file in the active project.",
              policy: "allow",
              defaultPolicy: "allow",
              overridden: false
            },
            {
              id: "copse:run-shell",
              executionName: "run_shell",
              name: "Run shell command",
              description: "Run a command in the project sandbox.",
              policy: "ask",
              defaultPolicy: "ask",
              overridden: false
            }
          ]
        },
        {
          id: "mcp:project:github",
          name: "github",
          kind: "mcp",
          origin: "project",
          originDetail: "/demo/crumb-and-bloom/.mcp.json",
          status: "connected",
          tools: [
            {
              id: "mcp:project:github:search-issues",
              executionName: "mcp__github__search_issues",
              name: "Search issues",
              description: "Search issues and pull requests in a repository.",
              policy: "allow",
              defaultPolicy: "ask",
              overridden: true
            },
            {
              id: "mcp:project:github:get-pull-request",
              executionName: "mcp__github__get_pull_request",
              name: "Get pull request",
              description: "Read a pull request, its diff, and its review comments.",
              policy: "allow",
              defaultPolicy: "ask",
              overridden: true
            },
            {
              id: "mcp:project:github:create-issue",
              executionName: "mcp__github__create_issue",
              name: "Create issue",
              description: "Open a new issue in a repository.",
              policy: "ask",
              defaultPolicy: "ask",
              overridden: false
            },
            {
              id: "mcp:project:github:add-issue-comment",
              executionName: "mcp__github__add_issue_comment",
              name: "Add issue comment",
              description: "Comment on an issue or pull request.",
              policy: "ask",
              defaultPolicy: "ask",
              overridden: false
            },
            {
              id: "mcp:project:github:merge-pull-request",
              executionName: "mcp__github__merge_pull_request",
              name: "Merge pull request",
              description: "Merge a pull request into its base branch.",
              policy: "block",
              defaultPolicy: "ask",
              overridden: true
            }
          ]
        }
      ]
    };
    SEASONAL_PR_BODY = [
      "Adds a seasonal flavours section below the hero.",
      "",
      "- Reads the current menu from `flavours.json`, so the bakery can swap flavours without touching markup",
      "- Pauses the flavour ticker for visitors who prefer reduced motion",
      "- Keeps the section to a single column on narrow screens"
    ].join("\n");
    SIGNUP_THREAD = {
      id: "demo-site-tour-signup",
      title: "Send signups to the newsletter",
      status: "idle",
      gitBranch: "main",
      model: SITE_TOUR_MODEL,
      messages: [
        {
          id: "demo-site-tour-signup-user-1",
          role: "user",
          content: "Where does the email signup get handled?",
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - 4 * 6e4
        },
        {
          id: "demo-site-tour-signup-assistant-1",
          role: "assistant",
          content: "In `script.js`: the form\u2019s submit handler checks the address, then shows the confirmation note under the form. Nothing is sent anywhere yet, so the address only lives in the page.",
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - 3 * 6e4
        },
        {
          id: "demo-site-tour-signup-user-2",
          role: "user",
          content: "Send new signups to the newsletter list instead of only showing the note.",
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - 2 * 6e4
        },
        {
          id: "demo-site-tour-signup-assistant-2",
          role: "assistant",
          content: "The submit handler now posts the address to the newsletter endpoint and only shows the confirmation note once the request succeeds. A failed request keeps what the visitor typed and offers to try again.",
          toolCalls: [],
          createdAt: SITE_TOUR_TIME - 6e4
        }
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: SITE_TOUR_TIME - 4 * 6e4,
      updatedAt: SITE_TOUR_TIME - 6e4
    };
    SITE_TOUR_SCENARIOS = [
      siteTourScenario("site-fork-resend", "Copse.dev tour: fork and resend a prompt", SIGNUP_THREAD, {
        // The site the thread is about, open in the Browser pane beside it.
        staticSite: "sites/cupcakes",
        settings: {
          ...SITE_TOUR_SETTINGS,
          layout: { projectsPaneWidth: 240, filesPaneWidth: 560 }
        }
      }),
      siteTourScenario("site-subagent", "Copse.dev tour: an expanded subagent", {
        id: "demo-site-tour-accessibility",
        title: "Accessibility audit",
        status: "idle",
        gitBranch: "main",
        model: SITE_TOUR_MODEL,
        messages: [
          {
            id: "demo-site-tour-accessibility-user",
            role: "user",
            content: "Check the coming-soon page for accessibility problems before we launch.",
            toolCalls: [],
            createdAt: SITE_TOUR_TIME - 3 * 6e4
          },
          {
            id: "demo-site-tour-accessibility-assistant",
            role: "assistant",
            content: "I asked an explore agent to audit the markup and styles.",
            toolCalls: [
              {
                id: "demo-site-tour-accessibility-explore",
                name: "explore",
                args: { query: "Audit index.html and styles.css for accessibility gaps" },
                status: "done",
                result: "Two gaps: the flavour ticker ignores reduced motion, and the signup field has no visible label.",
                subagent: {
                  id: "demo-site-tour-accessibility-session",
                  kind: "explore",
                  status: "done",
                  prompt: "Audit index.html and styles.css for accessibility gaps",
                  summary: "Two gaps: the flavour ticker ignores reduced motion, and the signup field has no visible label.",
                  model: SITE_TOUR_MODEL,
                  messages: [
                    {
                      id: "demo-site-tour-accessibility-explore-1",
                      role: "assistant",
                      content: "Reading the page structure and the stylesheet.",
                      toolCalls: [
                        {
                          id: "demo-site-tour-accessibility-read-html",
                          name: "read_file",
                          args: { path: "index.html" },
                          status: "done",
                          result: "<!doctype html>\n"
                        },
                        {
                          id: "demo-site-tour-accessibility-read-css",
                          name: "read_file",
                          args: { path: "styles.css" },
                          status: "done",
                          result: ":root {\n"
                        }
                      ]
                    },
                    {
                      id: "demo-site-tour-accessibility-explore-2",
                      role: "assistant",
                      content: "Checking whether the ticker animation respects **reduced motion**.",
                      toolCalls: [
                        {
                          id: "demo-site-tour-accessibility-grep",
                          name: "grep_search",
                          args: { pattern: "prefers-reduced-motion" },
                          status: "done",
                          result: "No matches."
                        }
                      ]
                    },
                    {
                      id: "demo-site-tour-accessibility-explore-3",
                      role: "assistant",
                      content: "Two gaps: the flavour ticker ignores reduced motion, and the signup field has no visible label.",
                      toolCalls: []
                    }
                  ]
                }
              }
            ],
            createdAt: SITE_TOUR_TIME - 2 * 6e4
          },
          {
            id: "demo-site-tour-accessibility-findings",
            role: "assistant",
            content: [
              "Two things to fix before launch:",
              "",
              "- The flavour ticker keeps scrolling for visitors who prefer reduced motion.",
              "- The signup field relies on its placeholder, so it has no visible label.",
              "",
              "Want me to fix both?"
            ].join("\n"),
            toolCalls: [],
            createdAt: SITE_TOUR_TIME - 6e4
          }
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: SITE_TOUR_TIME - 3 * 6e4,
        updatedAt: SITE_TOUR_TIME - 6e4
      }),
      siteTourScenario("site-archive-attachment", "Copse.dev tour: attach a zip archive", {
        // Empty: the spec drops the archive into this thread's composer.
        id: "demo-site-tour-brand-kit",
        title: "Swap in the new brand kit",
        status: "idle",
        gitBranch: "main",
        model: SITE_TOUR_MODEL,
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: SITE_TOUR_TIME,
        updatedAt: SITE_TOUR_TIME
      }),
      // Settings opens over the same conversation the fork shot uses.
      siteTourScenario("site-providers", "Copse.dev tour: provider settings", SIGNUP_THREAD),
      siteTourScenario(
        "site-create-pr",
        "Copse.dev tour: create a pull request",
        {
          id: "demo-site-tour-seasonal",
          title: "Add seasonal flavours",
          status: "idle",
          gitBranch: "seasonal-flavours",
          model: SITE_TOUR_MODEL,
          messages: [
            {
              id: "demo-site-tour-seasonal-user",
              role: "user",
              content: "Add a seasonal flavours section under the hero that reads from flavours.json, and make sure the ticker respects reduced motion.",
              toolCalls: [],
              createdAt: SITE_TOUR_TIME - 3 * 6e4
            },
            {
              id: "demo-site-tour-seasonal-assistant",
              role: "assistant",
              content: "Added the seasonal flavours section and committed it on `seasonal-flavours`. The ticker now pauses for visitors who prefer reduced motion.",
              toolCalls: [],
              createdAt: SITE_TOUR_TIME - 6e4
            }
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: SITE_TOUR_TIME - 3 * 6e4,
          updatedAt: SITE_TOUR_TIME - 6e4
        },
        {
          changeStats: { additions: 86, deletions: 12 },
          followUps: [
            { id: "create-pr", label: "Create PR", action: "create-pr" },
            { id: "review", label: "Review changes", action: "review" }
          ],
          prBody: SEASONAL_PR_BODY
        }
      ),
      siteTourScenario(
        "site-mcp-permissions",
        "Copse.dev tour: per-tool MCP permissions",
        {
          id: "demo-site-tour-triage",
          title: "Triage launch issues",
          status: "idle",
          gitBranch: "main",
          model: SITE_TOUR_MODEL,
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: SITE_TOUR_TIME,
          updatedAt: SITE_TOUR_TIME
        },
        {
          mcpServers: [SITE_TOUR_GITHUB_MCP],
          toolPermissions: SITE_TOUR_TOOL_PERMISSIONS
        }
      )
    ];
  }
});

// src/shared/demo-concise-states.ts
function scenario(id, label, messages, { status = "idle", ...extra } = {}) {
  return {
    id: `concise-state-${id}`,
    label,
    project: PROJECT,
    settings: {
      onboardingCompleted: true,
      theme: "dark",
      uiTintStrength: "off",
      model: CAPABLE,
      conciseThreadsEnabled: true
    },
    threads: [
      {
        id: `demo-concise-state-${id}`,
        title: "Concise thread view",
        status,
        model: CAPABLE,
        messages,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: TIME,
        updatedAt: TIME
      }
    ],
    ...extra
  };
}
var CONCISE_SCREENSHOT, TIME, CAPABLE, MODEST, PROJECT, clock, user, assistant, read, edit, shell, outcome, LONG_OUTPUT, PATCH, THREAD_ID, CONCISE_STATE_SCENARIOS;
var init_demo_concise_states = __esm({
  "src/shared/demo-concise-states.ts"() {
    init_tool_interruption();
    CONCISE_SCREENSHOT = `data:image/svg+xml;base64,${btoa(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">',
        '<rect width="480" height="270" fill="#f4f1ea"/>',
        '<rect width="480" height="36" fill="#2f3a2f"/>',
        '<text x="16" y="23" font-family="sans-serif" font-size="14" fill="#fff">Settings</text>',
        '<rect x="16" y="56" width="200" height="14" rx="3" fill="#c9c2b3"/>',
        '<rect x="16" y="84" width="448" height="44" rx="6" fill="#fff" stroke="#d8d2c4"/>',
        '<rect x="16" y="140" width="448" height="44" rx="6" fill="#fff" stroke="#d8d2c4"/>',
        '<rect x="384" y="210" width="80" height="32" rx="6" fill="#4f7a4f"/>',
        '<text x="405" y="231" font-family="sans-serif" font-size="13" fill="#fff">Save</text>',
        "</svg>"
      ].join("")
    )}`;
    TIME = Date.UTC(2026, 6, 17, 9, 0, 0);
    CAPABLE = "claude-opus-5-5";
    MODEST = "claude-haiku-4-5";
    PROJECT = {
      id: "demo-concise-states-project",
      name: "copse-demo",
      path: "/demo/copse"
    };
    clock = 0;
    user = (id, content, extra = {}) => ({
      id,
      role: "user",
      content,
      toolCalls: [],
      createdAt: TIME + ++clock * 1e3,
      ...extra
    });
    assistant = (id, content, toolCalls = [], extra = {}) => ({
      id,
      role: "assistant",
      model: CAPABLE,
      content,
      toolCalls,
      createdAt: TIME + ++clock * 1e3,
      ...extra
    });
    read = (id, path = "src/renderer/views/settings-dialog.ts") => ({
      id,
      name: "read_file",
      args: { path },
      status: "done",
      result: "export function mountSettings() { \u2026 }"
    });
    edit = (id) => ({
      id,
      name: "str_replace",
      args: { path: "src/renderer/styles/settings.css" },
      status: "done",
      result: "Replaced 1 occurrence.",
      editStats: { additions: 4, deletions: 2 }
    });
    shell = (id, command, status = "done", result = "\u2139 pass 12") => ({ id, name: "run_shell", args: { command }, status, result });
    outcome = (status, extra = {}) => ({
      status,
      stopReason: status === "failed" ? "error" : status === "cancelled" ? "cancelled" : "end_turn",
      source: status === "cancelled" ? "user" : "provider",
      executor: "local",
      provider: "anthropic",
      model: CAPABLE,
      endedAt: TIME + 6e4,
      ...extra
    });
    LONG_OUTPUT = Array.from(
      { length: 400 },
      (_, i) => `\u2139 test ${String(i + 1).padStart(3, "0")} \u203A settings form keeps Save pinned (${String(i % 9)}ms)`
    ).join("\n");
    PATCH = [
      "*** Begin Patch",
      "*** Update File: src/renderer/styles/settings.css",
      "@@",
      "-.settings-footer { position: absolute; bottom: 0; }",
      "+.settings-footer { display: grid; align-items: end; }",
      "*** End Patch"
    ].join("\n");
    THREAD_ID = (id) => `demo-concise-state-${id}`;
    CONCISE_STATE_SCENARIOS = [
      scenario("stopped", "A turn the user stopped partway", [
        user("stopped-user", "Fix the settings form so Save stays aligned on narrow windows."),
        assistant(
          "stopped-work",
          "",
          [
            read("stopped-read"),
            shell(
              "stopped-test",
              "pnpm test -- settings-forms",
              "error",
              ACP_CANCELLED_TOOL_CALL_RESULT
            )
          ],
          { turnOutcome: outcome("cancelled", { userAbort: "stop" }) }
        )
      ]),
      scenario("interrupted-by-message", "A turn cut off by a new message, then answered", [
        user("cut-user", "Fix the settings form so Save stays aligned on narrow windows."),
        assistant(
          "cut-work",
          "",
          [shell("cut-test", "pnpm test -- settings-forms", "error", ACP_CANCELLED_TOOL_CALL_RESULT)],
          { turnOutcome: outcome("cancelled", { userAbort: "send_now" }) }
        ),
        user("cut-next", "Actually, leave the tests alone and only change the CSS."),
        assistant("cut-edit", "Editing the stylesheet.", [edit("cut-edit-call")]),
        assistant("cut-done", "Save is pinned with a grid footer; no test files were touched.", [], {
          turnOutcome: outcome("completed")
        })
      ]),
      // No `conciseThreadsEnabled` stored at all: a profile that never touched the setting.
      scenario(
        "default-on",
        "A capable model\u2019s turn on a profile with no stored setting",
        [
          user("default-user", "Fix the settings form so Save stays aligned on narrow windows."),
          assistant("default-work", "Reading the form.", [read("default-read"), edit("default-edit")]),
          assistant("default-done", "Save now stays pinned at every width.", [], {
            turnOutcome: outcome("completed")
          })
        ],
        {
          settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off", model: CAPABLE }
        }
      ),
      scenario("recovery-layout", "Interrupted turn with a long fallback model name", [
        user("recovery-earlier-user", "Check the settings form."),
        assistant("recovery-earlier", "The form needs a layout fix.", [], {
          model: "claude-haiku-4-5-20251001",
          turnOutcome: outcome("completed", { model: "claude-haiku-4-5-20251001" })
        }),
        user("recovery-user", "Fix the settings form."),
        assistant("recovery-failed", "I found the footer, then the provider stopped responding.", [], {
          turnOutcome: outcome("failed", { error: { message: "Provider disconnected." } })
        })
      ]),
      scenario("failed", "A turn that failed partway", [
        user("failed-user", "Fix the settings form so Save stays aligned on narrow windows."),
        assistant(
          "failed-work",
          "I read the form and found the footer, then the provider stopped responding.",
          [read("failed-read"), edit("failed-edit")],
          {
            turnOutcome: outcome("failed", {
              error: { message: "The model provider is overloaded (529). Try again in a moment." }
            })
          }
        )
      ]),
      scenario(
        "approval",
        "A running turn waiting for permission",
        [
          user("approval-user", "Install the dependencies and run the settings tests."),
          assistant("approval-work", "Installing first.", [
            read("approval-read", "package.json"),
            shell("approval-install", "pnpm install", "running", null)
          ])
        ],
        {
          status: "running",
          approvalRequests: [
            {
              id: "concise-state-approval-request",
              threadId: THREAD_ID("approval"),
              title: "Run outside sandbox?",
              body: "pnpm install",
              bodyAdvice: "The project sandbox would block this command:\n\u2022 Installs or updates packages, which downloads and runs code from the internet",
              bodyFooter: "Allow running it once outside the sandbox?",
              type: "shell"
            }
          ]
        }
      ),
      scenario(
        "question",
        "A running turn waiting for an answer",
        [
          user("question-user", "Bump the schema."),
          assistant("question-work", "Reading the migrations.", [
            read("question-read", "db/migrations/0042.sql"),
            {
              id: "question-ask",
              name: "ask_user",
              args: { questions: [{ question: "Which migration order should the schema bump use?" }] },
              status: "running",
              result: null
            }
          ])
        ],
        {
          status: "running",
          askUserRequests: [
            {
              id: "concise-state-question-request",
              threadId: THREAD_ID("question"),
              questions: [
                {
                  question: "Which migration order should the schema bump use?",
                  options: ["Columns first", "Backfill first"]
                }
              ]
            }
          ]
        }
      ),
      scenario(
        "reauth",
        "A failed coding-agent turn offering a direct sign-in action",
        [
          user("reauth-user", "Continue with Claude."),
          assistant("reauth-failed", "Claude is not signed in, so this turn could not run.")
        ],
        {
          status: "running",
          askUserRequests: [
            {
              id: "concise-state-reauth-request",
              threadId: THREAD_ID("reauth"),
              presentation: { kind: "actions", title: "Sign in to Claude" },
              questions: [
                {
                  question: "Claude is not signed in, so this turn could not run. Open a terminal and run `claude auth login` to sign in again? Finish signing in there, then re-send your message.",
                  options: ["Sign in", "Not now"]
                }
              ]
            }
          ]
        }
      ),
      scenario("subagent", "A finished turn that used subagents", [
        user("subagent-user", "Find where the footer is laid out and review the auth changes."),
        assistant("subagent-work", "Delegating the search.", [
          {
            id: "subagent-explore",
            name: "explore",
            args: { query: "Find the settings footer" },
            status: "done",
            result: "The footer lives in settings.css.",
            subagent: {
              id: "subagent-explore-session",
              kind: "explore",
              status: "done",
              prompt: "Find the settings footer",
              summary: "The footer lives in settings.css.",
              messages: [
                {
                  id: "subagent-explore-1",
                  role: "assistant",
                  content: "Reading **settings.css**.",
                  toolCalls: [read("subagent-inner-read", "src/renderer/styles/settings.css")]
                }
              ]
            }
          }
        ]),
        assistant(
          "subagent-done",
          "The footer is an absolutely positioned row in `settings.css`.",
          [],
          {
            turnOutcome: outcome("completed")
          }
        )
      ]),
      scenario(
        "subagent-running",
        "A running turn with a subagent at work",
        [
          user("subagent-live-user", "Find where the footer is laid out."),
          assistant("subagent-live-work", "Delegating the search.", [
            {
              id: "subagent-live-explore",
              name: "explore",
              args: { query: "Find the settings footer" },
              status: "running",
              result: null,
              subagent: {
                id: "subagent-live-session",
                kind: "explore",
                status: "running",
                prompt: "Find the settings footer",
                summary: null,
                messages: []
              }
            }
          ])
        ],
        { status: "running" }
      ),
      scenario("long-output", "A finished turn with long output, an edit and a patch", [
        user("long-user", "Move the footer to a grid and run the whole settings suite."),
        assistant("long-work", "Applying the change, then running every test.", [
          edit("long-edit"),
          {
            id: "long-patch",
            name: "apply_patch",
            args: { input: PATCH },
            status: "done",
            result: "Applied.",
            editStats: { additions: 1, deletions: 1 }
          },
          shell("long-suite", "pnpm test -- settings", "done", LONG_OUTPUT)
        ]),
        assistant("long-done", "All 400 settings tests pass with the grid footer.", [], {
          turnOutcome: outcome("completed")
        })
      ]),
      scenario("terminal", "A finished turn from an agent that ran a terminal", [
        user("terminal-user", "Run the settings tests."),
        assistant("terminal-work", "Running them in a terminal.", [
          {
            id: "terminal-call",
            name: "run_shell",
            title: "pnpm test -- settings",
            kind: "execute",
            args: { command: "pnpm test -- settings" },
            status: "done",
            result: "\u2139 pass 12",
            content: [{ type: "terminal", terminalId: "demo-terminal-1" }]
          }
        ]),
        assistant("terminal-done", "The settings tests pass.", [], {
          turnOutcome: outcome("completed")
        })
      ]),
      scenario("attachments", "A prompt with attachments, answered concisely", [
        user("attach-user", "Match the footer in this screenshot, using the notes and the spec.", {
          images: [CONCISE_SCREENSHOT],
          attachments: [
            { kind: "file", label: "settings.css" },
            {
              kind: "paste",
              label: "Pasted text \xB7 42 lines",
              content: "footer {\n  position: absolute;\n}"
            }
          ]
        }),
        assistant("attach-work", "Comparing the footer with the screenshot.", [
          read("attach-read", "src/renderer/styles/settings.css"),
          edit("attach-edit")
        ]),
        assistant("attach-done", "The footer now matches your screenshot.", [], {
          turnOutcome: outcome("completed")
        })
      ]),
      scenario("resumed", "An old thread resumed with a capable model", [
        user("old-user", "What does the settings footer do?"),
        {
          id: "old-work",
          role: "assistant",
          content: "Let me look at the footer first.",
          toolCalls: [read("old-read")],
          createdAt: TIME + ++clock * 1e3
        },
        {
          id: "old-done",
          role: "assistant",
          content: "It pins Save to the bottom of the dialog.",
          toolCalls: [],
          createdAt: TIME + ++clock * 1e3
        },
        user("new-user", "Make it a grid so it stays aligned."),
        assistant("new-work", "Rewriting the footer.", [edit("new-edit")]),
        assistant("new-done", "The footer is a grid now.", [], { turnOutcome: outcome("completed") })
      ]),
      scenario("model-switch", "A thread that switches models between turns", [
        user("switch-user-1", "Find the footer rule."),
        assistant("switch-work-1", "Searching the styles.", [read("switch-read-1")]),
        assistant("switch-done-1", "It is in `settings.css`.", [], {
          turnOutcome: outcome("completed")
        }),
        user("switch-user-2", "Now change it."),
        assistant("switch-work-2", "Editing the rule.", [edit("switch-edit-2")], { model: MODEST }),
        assistant("switch-done-2", "Changed to a grid.", [], {
          model: MODEST,
          turnOutcome: outcome("completed", { model: MODEST })
        }),
        user("switch-user-3", "Run the tests."),
        assistant("switch-work-3", "Running them.", [
          shell("switch-test-3", "pnpm test -- settings-forms")
        ]),
        assistant("switch-done-3", "All settings tests pass.", [], {
          turnOutcome: outcome("completed")
        })
      ])
    ];
  }
});

// src/shared/demo-bridged-tools.ts
var CREATED_AT, MODEL, PATCH2, BRIDGED_TOOL_SCENARIOS;
var init_demo_bridged_tools = __esm({
  "src/shared/demo-bridged-tools.ts"() {
    CREATED_AT = Date.UTC(2026, 9, 11, 9);
    MODEL = "claude-opus-5-5";
    PATCH2 = [
      "*** Begin Patch",
      "*** Update File: src/greeting.ts",
      "-hello",
      "+hello, world",
      "*** Add File: src/farewell.ts",
      "+goodbye",
      "*** End Patch"
    ].join("\n");
    BRIDGED_TOOL_SCENARIOS = [
      {
        id: "bridged-thread-proposals",
        label: "Two proposed follow-up threads",
        project: { id: "demo-proposals-project", name: "Follow-up work", path: "/demo/proposals" },
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off", model: MODEL },
        threads: [
          {
            id: "demo-proposals-thread",
            title: "Settings follow-up",
            status: "idle",
            model: MODEL,
            messages: [
              {
                id: "proposals-user",
                role: "user",
                content: "Propose separate threads for these two settings fixes.",
                toolCalls: [],
                createdAt: CREATED_AT
              },
              {
                id: "proposals-assistant",
                role: "assistant",
                content: "Here are the two proposed threads.",
                createdAt: CREATED_AT,
                toolCalls: [
                  {
                    id: "proposal-read-1",
                    name: "read_file",
                    args: { path: "settings.ts" },
                    status: "done",
                    result: "Read settings."
                  },
                  {
                    id: "proposal-read-2",
                    name: "read_file",
                    args: { path: "agents.ts" },
                    status: "done",
                    result: "Read agents."
                  },
                  ...[
                    {
                      title: "Fix Codex readiness detection",
                      summary: "Show the correct sign-in status and verify refresh behavior."
                    },
                    {
                      title: "Finish the combined Models & agents list",
                      summary: "Bring coding agents, API keys and model servers into one settings list."
                    }
                  ].map((proposal, index) => ({
                    id: `wrapped-proposal-${String(index)}`,
                    name: "mcp.copse.propose_thread",
                    title: "mcp.copse.propose_thread",
                    kind: "execute",
                    args: {
                      server: "copse",
                      tool: "propose_thread",
                      arguments: { ...proposal, prompt: `${proposal.title}. Add focused tests.` }
                    },
                    status: "done",
                    result: "Offered to the user."
                  }))
                ]
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT
          }
        ]
      },
      {
        id: "bridged-tools",
        label: "Patch file links and command output",
        project: { id: "demo-bridge-project", name: "Bridge tools", path: "/demo/bridge" },
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off", model: MODEL },
        threads: [
          {
            id: "demo-bridge-thread",
            title: "Update greetings",
            status: "idle",
            model: MODEL,
            messages: [
              {
                id: "bridge-user",
                role: "user",
                content: "Update the greetings.",
                toolCalls: [],
                createdAt: CREATED_AT
              },
              {
                id: "bridge-patch",
                role: "assistant",
                content: "Updated both greetings.",
                createdAt: CREATED_AT,
                toolCalls: [
                  {
                    id: "bridge-patch-call",
                    name: "copse.apply_patch",
                    args: { input: PATCH2 },
                    status: "done",
                    result: "Patched two files."
                  }
                ]
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT
          }
        ],
        trace: {
          id: "bridge-shell-trace",
          label: "Run greeting tests",
          prompt: "Run the greeting tests.",
          steps: [
            {
              chunk: {
                type: "tool_call",
                toolCall: {
                  id: "bridge-shell",
                  name: "Run greeting tests",
                  programmaticName: "mcp__copse__run_shell",
                  args: { command: "pnpm test greetings" }
                }
              }
            },
            {
              chunk: {
                type: "tool_result",
                toolCallId: "bridge-shell",
                result: "2 greeting tests passed.",
                isError: false
              }
            },
            { chunk: { type: "text", text: "Both greeting tests passed." } },
            { chunk: { type: "done", stopReason: "end_turn" } }
          ]
        }
      },
      {
        id: "bridged-tools-concise",
        label: "Running command in concise view",
        project: { id: "demo-bridge-concise-project", name: "Bridge tools", path: "/demo/bridge" },
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          model: MODEL,
          conciseThreadsEnabled: true
        },
        threads: [
          {
            id: "demo-bridge-concise-thread",
            title: "Test greetings",
            status: "running",
            model: MODEL,
            messages: [
              {
                id: "bridge-concise-user",
                role: "user",
                content: "Run the greeting tests.",
                toolCalls: [],
                createdAt: CREATED_AT
              },
              {
                id: "bridge-concise-shell",
                role: "assistant",
                content: "",
                model: MODEL,
                createdAt: CREATED_AT,
                toolCalls: [
                  {
                    id: "bridge-running-shell",
                    name: "copse-run_shell: Test greetings",
                    args: { command: "pnpm test greetings" },
                    status: "running",
                    result: null
                  }
                ]
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT
          }
        ]
      }
    ];
  }
});

// src/shared/approval-copy.ts
function threadAccessApproval(access) {
  return {
    title: access === "read" ? "Read your other threads?" : "Send prompts to your other threads?",
    body: "",
    bodyAdvice: access === "read" ? "Allow this thread to read all your other conversations." : "Allow this thread to send prompts that run in your other conversations.",
    bodyFooter: "Applies only to this thread. Revoke it in the thread\u2019s Context panel \u2192 Permissions.",
    approveLabel: access === "read" ? "Allow reading" : "Allow sending",
    allowRemember: false
  };
}
function webApprovalDetails(origin, url, allowRemember, context) {
  return {
    body: url,
    bodyAdvice: `The agent wants to contact ${origin}. The site can see the request and any data in its URL.` + (context ? `

${context}` : ""),
    bodyFooter: allowRemember ? "Allow this request once. \u201CAlways allow\u201D permits future requests to this origin, including other URLs, and is saved in Settings." : "Allow this request once. This does not add the origin to Settings."
  };
}
function browserApprovalDetails(origin, url, allowRemember) {
  return {
    body: url,
    bodyAdvice: `The agent wants to open a browser page on ${origin}. The site can see the request and any data in its URL.`,
    bodyFooter: "Approval allows navigation to this origin for this chat\u2019s browser session." + (allowRemember ? " \u201CAlways allow\u201D also permits future requests to this origin and is saved in Settings." : "")
  };
}
function providerApprovalDetails(host, baseUrl) {
  return {
    body: baseUrl.trim(),
    bodyAdvice: `Your API key and prompts will be sent to ${host} at this base URL:`,
    bodyFooter: "Approval always allows this provider host, including other base URLs on it. The grant is saved in Settings."
  };
}
var init_approval_copy = __esm({
  "src/shared/approval-copy.ts"() {
  }
});

// src/shared/demo-scenarios.ts
function demoScenarioPrompt(scenario2) {
  return scenario2.trace?.prompt ?? "";
}
function conciseThreadMessages(model, live) {
  return [
    {
      id: `concise-user-${model}`,
      role: "user",
      content: "Fix the settings form so Save stays aligned on narrow windows.",
      toolCalls: [],
      createdAt: FIXED_TIME
    },
    {
      id: `concise-step-1-${model}`,
      role: "assistant",
      model,
      reasoning: "The Save button is absolutely positioned; check the form layout first.",
      content: "Let me look at how the settings form lays out its footer.",
      toolCalls: [
        {
          id: `concise-read-${model}`,
          name: "read_file",
          args: { path: "src/renderer/views/settings-dialog.ts" },
          status: "done",
          result: "export function mountSettings() { \u2026 }"
        },
        {
          id: `concise-edit-${model}`,
          name: "str_replace",
          args: { path: "src/renderer/styles/settings.css" },
          status: "done",
          result: "Replaced 1 occurrence.",
          editStats: { additions: 4, deletions: 2 }
        },
        {
          id: `concise-test-fail-${model}`,
          name: "run_shell",
          args: { command: "pnpm test -- settings-forms" },
          status: "error",
          result: "Error: settings-forms.test.ts expected footer to use grid"
        },
        {
          id: `concise-test-pass-${model}`,
          name: "run_shell",
          args: { command: "pnpm test -- settings-forms" },
          status: live ? "running" : "done",
          result: live ? null : "\u2139 pass 12"
        }
      ],
      createdAt: FIXED_TIME + 1e3
    },
    ...live ? [] : [
      {
        id: `concise-step-2-${model}`,
        role: "assistant",
        model,
        content: "Capturing the narrow layout to confirm.",
        toolCalls: [
          {
            id: `concise-shot-${model}`,
            name: "browser_screenshot",
            args: { width: 480 },
            status: "done",
            result: "Captured the settings dialog at 480px.",
            images: [
              {
                dataUrl: CONCISE_SCREENSHOT,
                name: "settings-480px.png",
                kind: "screenshot"
              }
            ]
          }
        ],
        createdAt: FIXED_TIME + 2e3
      },
      {
        id: `concise-summary-${model}`,
        role: "assistant",
        model,
        content: "Save now stays pinned to the form footer at every width: the footer is a grid instead of an absolutely positioned row. The settings form tests pass.",
        toolCalls: [
          {
            id: `concise-audit-${model}`,
            name: "workspace_edit_audit",
            args: {},
            status: "done",
            result: "Audit complete."
          }
        ],
        createdAt: FIXED_TIME + 3e3
      }
    ]
  ];
}
function conciseMultiTurnMessages(model) {
  const turn = (n, prompt, replies, { tools = false, screenshot = false } = {}) => {
    const at = FIXED_TIME + n * 1e4;
    return [
      {
        id: `concise-multi-user-${String(n)}`,
        role: "user",
        content: prompt,
        toolCalls: [],
        createdAt: at
      },
      ...tools ? [
        {
          id: `concise-multi-steps-${String(n)}`,
          role: "assistant",
          model,
          content: "",
          toolCalls: [
            {
              id: `concise-multi-read-${String(n)}`,
              name: "read_file",
              args: { path: "src/renderer/views/settings-dialog.ts" },
              status: "done",
              result: "export function mountSettings() { \u2026 }"
            },
            {
              id: `concise-multi-edit-${String(n)}`,
              name: "str_replace",
              args: { path: "src/renderer/styles/settings.css" },
              status: "done",
              result: "Replaced 1 occurrence.",
              editStats: { additions: 3, deletions: 1 }
            }
          ],
          createdAt: at + 1
        }
      ] : [],
      ...screenshot ? [
        {
          id: `concise-multi-shot-${String(n)}`,
          role: "assistant",
          model,
          content: "Capturing the narrow layout.",
          toolCalls: [
            {
              id: `concise-multi-capture-${String(n)}`,
              name: "browser_screenshot",
              args: { width: 480 },
              status: "done",
              result: "Captured the settings dialog at 480px.",
              images: [
                {
                  dataUrl: CONCISE_SCREENSHOT,
                  name: "settings-480px.png",
                  kind: "screenshot"
                }
              ]
            }
          ],
          createdAt: at + 2
        }
      ] : [],
      ...replies.map((content, i) => ({
        id: `concise-multi-reply-${String(n)}-${String(i)}`,
        role: "assistant",
        model,
        content,
        toolCalls: [
          {
            id: `concise-multi-audit-${String(n)}-${String(i)}`,
            name: "sandbox_network_audit",
            args: {},
            status: "done",
            result: "Audit complete."
          }
        ],
        createdAt: at + 3 + i
      }))
    ];
  };
  return [
    ...turn(
      1,
      "Fix the settings form so Save stays aligned on narrow windows.",
      ["Save now stays pinned to the footer at every width. The settings form tests pass."],
      { tools: true, screenshot: true }
    ),
    ...turn(2, "Why was it misaligned?", [
      "The footer was absolutely positioned, so it ignored the form width.",
      "I switched it to a grid so it follows the content box."
    ]),
    ...turn(3, "Rename the helper too.", ["Renamed `pinFooter` to `layoutFooter` in 3 files."], {
      tools: true
    }),
    ...turn(4, "Anything else?", ["No. Nothing else needs changing."]),
    ...turn(5, "Show me the narrow layout again.", ["Here is the 480px layout after the rename."], {
      tools: true,
      screenshot: true
    })
  ];
}
function conciseThreadScenario(id, label, model, {
  live = false,
  enabled = true,
  multiTurn = false
} = {}) {
  return {
    id,
    label,
    project: project(`demo-${id}-project`),
    settings: {
      onboardingCompleted: true,
      theme: "dark",
      uiTintStrength: "off",
      model,
      conciseThreadsEnabled: enabled,
      // An opt-out stored on a profile that has already seen the default flip;
      // without the marker, startup would clear it as a pre-default `false`.
      ...enabled ? {} : { conciseThreadsDefaultMigrated: true }
    },
    threads: [
      {
        id: `demo-${id}-thread`,
        title: "Concise thread view",
        status: live ? "running" : "idle",
        model,
        messages: multiTurn ? [
          ...conciseMultiTurnMessages(model),
          ...live ? conciseThreadMessages(model, true) : []
        ] : conciseThreadMessages(model, live),
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME
      }
    ]
  };
}
function approvalRiskScenario(id, request) {
  return {
    id,
    label: request.title,
    project: project(`demo-${id}-project`),
    settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off" },
    threads: [
      {
        id: `demo-${id}-thread`,
        title: "Review requested access",
        status: "idle",
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME
      }
    ],
    approvalRequests: [request]
  };
}
var FIXED_TIME, SIDE_CHATS_MAIN_ID, SIDE_CHATS_OTHER_ID, FOOTER_INPUT_TOKENS, FOOTER_OUTPUT_TOKENS, MOBILE_COMPANION_DEMO_URL, MOBILE_COMPANION_DEMO_QR_SVG, DEMO_CODEX_ACP_AGENT, FOOTER_COMPACT_EXPECTATIONS, markdownContent, syntaxContrastContent, project, semanticSearchSummary, readingLayoutContent, READING_LAYOUT_TRACE, PROPOSED_INDEX_HTML, PROPOSED_STYLES_CSS, PROPOSED_DIFF_TRACE, SIDE_CHATS_THREADS, SIDE_CHAT_RICH_THREADS, DEMO_SCENARIOS;
var init_demo_scenarios = __esm({
  "src/shared/demo-scenarios.ts"() {
    init_landing();
    init_demo_site_tour();
    init_demo_concise_states();
    init_demo_bridged_tools();
    init_approval_copy();
    FIXED_TIME = Date.UTC(2026, 6, 17, 9, 0, 0);
    SIDE_CHATS_MAIN_ID = "7b3e9a10-5c2d-4f6e-8a41-0d9c2b7e5f13";
    SIDE_CHATS_OTHER_ID = "3c1f0a52-8b3e-4d7a-9f10-2a6b7c8d9e01";
    FOOTER_INPUT_TOKENS = 5e4;
    FOOTER_OUTPUT_TOKENS = 1800;
    MOBILE_COMPANION_DEMO_URL = "https://192.168.1.42:42773";
    MOBILE_COMPANION_DEMO_QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 27 27" shape-rendering="crispEdges"><path fill="#ffffff" d="M0 0h27v27H0z"/><path stroke="#000000" d="M1 1.5h7m3 0h3m1 0h1m3 0h7M1 2.5h1m5 0h1m3 0h1m1 0h1m2 0h1m2 0h1m5 0h1M1 3.5h1m1 0h3m1 0h1m1 0h1m3 0h2m1 0h2m1 0h1m1 0h3m1 0h1M1 4.5h1m1 0h3m1 0h1m1 0h2m2 0h2m1 0h1m2 0h1m1 0h3m1 0h1M1 5.5h1m1 0h3m1 0h1m1 0h1m5 0h2m2 0h1m1 0h3m1 0h1M1 6.5h1m5 0h1m1 0h2m2 0h3m1 0h1m1 0h1m5 0h1M1 7.5h7m1 0h1m1 0h1m1 0h1m1 0h1m1 0h7M9 8.5h3m4 0h1M1 9.5h1m1 0h5m2 0h2m1 0h2m2 0h1m1 0h5M2 10.5h2m1 0h1m2 0h1m1 0h1m1 0h3m1 0h2m1 0h1m4 0h1M1 11.5h2m3 0h2m1 0h1m1 0h2m4 0h3m1 0h2m1 0h2M3 12.5h1m2 0h1m1 0h1m1 0h1m1 0h1m4 0h1m7 0h1M3 13.5h1m2 0h5m1 0h1m2 0h2m1 0h4m1 0h3M1 14.5h2m1 0h2m3 0h2m2 0h1m2 0h7m1 0h1M1 15.5h1m1 0h1m1 0h5m1 0h1m6 0h1m1 0h3m1 0h2M1 16.5h1m2 0h2m4 0h2m1 0h3m1 0h2m1 0h1m4 0h1M1 17.5h1m1 0h2m2 0h2m1 0h2m1 0h1m3 0h5m1 0h1M9 18.5h1m1 0h1m4 0h2m3 0h2M1 19.5h7m3 0h3m3 0h1m1 0h1m1 0h1m1 0h3M1 20.5h1m5 0h1m1 0h1m2 0h1m4 0h1m3 0h2m1 0h2M1 21.5h1m1 0h3m1 0h1m1 0h4m3 0h10M1 22.5h1m1 0h3m1 0h1m1 0h1m1 0h1m1 0h2m6 0h2m2 0h1M1 23.5h1m1 0h3m1 0h1m1 0h1m4 0h3m1 0h1m1 0h3m2 0h1M1 24.5h1m5 0h1m5 0h2m4 0h5m1 0h1M1 25.5h7m1 0h1m1 0h1m1 0h1m1 0h11"/></svg>';
    DEMO_CODEX_ACP_AGENT = {
      id: "codex-acp",
      title: "Codex",
      command: "codex-acp",
      args: [],
      enabled: true
    };
    FOOTER_COMPACT_EXPECTATIONS = {
      tokenLabel: `${((FOOTER_INPUT_TOKENS + FOOTER_OUTPUT_TOKENS) / 1e3).toFixed(1)}k tokens`
    };
    markdownContent = [
      "### \u26A0\uFE0F Known Failures",
      "",
      "**Unit tests (2 failures):**",
      "- `terminal-service` \u2014 2 subtests fail with posix spawnp failed",
      "",
      "**E2E tests (all 10 fail):**",
      "- Every e2e test fails with listen EPERM: operation not permitted 0.0.0.0",
      "",
      "### \u{1F4E6} Architecture Highlights",
      "- Electron app \u2014 AI coding assistant with tool-executing agents",
      "- No backend \u2014 Direct LLM provider calls (Anthropic, OpenAI, LM Studio)",
      "- Mock LLM \u2014 `COPSE-PANEL-MOCK-LLM=1` enables full e2e testing without API keys",
      "- MCP host \u2014 Per-server enable toggles in Settings",
      "- Persistence \u2014 filesystem-native threads and project settings"
    ].join("\n");
    syntaxContrastContent = [
      "Here is the resolved model configuration:",
      "",
      "```json",
      "{",
      '  "model": "claude-opus-4",',
      '  "temperature": 0.2,',
      '  "maxTokens": 8192,',
      '  "stream": true',
      "}",
      "```",
      "",
      "and the loop that reads it:",
      "",
      "```ts",
      "// Resolve the model for this turn.",
      "function resolveModel(settings: Settings): string {",
      "  return settings.model ?? 'claude-opus-4'",
      "}",
      "```"
    ].join("\n");
    project = (id, name = "copse-demo", path = "/demo/copse") => ({
      id,
      path,
      name
    });
    semanticSearchSummary = [
      "Here is the complete summary of how semantic search is classified, routed, and executed:",
      "",
      "---",
      "",
      "## Search Routing Summary ('search-routing.ts')",
      "",
      "### 1. Classification ('classifySearchQuery')",
      "",
      "**File:** `src/main/services/search-routing.ts`",
      "",
      "The router picks semantic vs grep based on query shape.",
      "",
      "- **Semantic path** \u2014 embedding search via `search_codebase`",
      "- **Grep path** \u2014 ripgrep via `grep_search`",
      "",
      "### 2. Execution",
      "",
      "Let me find where this classification function is called.",
      "",
      "- Read `search-routing.ts`",
      "- Search for `classifySearchQuery`"
    ].join("\n");
    readingLayoutContent = [
      "A response should be comfortable to read from the first streamed sentence through the final answer. The prose stays within a readable measure while the surrounding chat can still hold wider tool output.",
      "",
      "This second paragraph checks the separation between ideas. Short answers should keep their natural height, and longer explanations should wrap without pushing the chat pane sideways.",
      "",
      "## What changed",
      "",
      "- **A readable column:** keeps long lines from crossing the entire window.",
      "- Paragraphs and sections have enough separation to scan.",
      "  - Nested details retain their indentation.",
      "  - A second nested item checks the list rhythm.",
      "- Pending markdown uses the same text size as the completed answer.",
      "- A [**bold link**](https://example.com) keeps the link colour.",
      "",
      "### Review the details",
      "",
      "Inline paths such as `src/renderer/styles/global/conversation.css` remain selectable. A long command below scrolls within its code block.",
      "",
      "```sh",
      "pnpm run test:demo --spec tests/demo/chat-reading-layout.demo.ts --spec tests/demo/markdown-list-indent.demo.ts --spec tests/demo/chat-layout-styling.demo.ts",
      "```",
      "",
      "| Surface | Expected behavior |",
      "| --- | --- |",
      "| Prose | Wrap to the available reading width |",
      "| Code | Scroll inside the fenced block |",
      "| Tool output | Keep the existing trace typography |",
      "",
      "> A quote remains part of the response and keeps its own visual treatment.",
      "",
      "## Limits",
      "",
      "This is a deterministic layout fixture. It does not claim that an agent inspected files or ran these checks."
    ].join("\n");
    READING_LAYOUT_TRACE = {
      id: "chat-reading-layout",
      label: "Reading layout with a tool and streamed markdown",
      prompt: "Show the reading layout with a streamed response.",
      steps: [
        { chunk: { type: "text", text: "I will inspect the sample before explaining it.\n\n" } },
        {
          chunk: {
            type: "tool_call",
            toolCall: { id: "reading-layout-read", name: "read_file", args: { path: "sample.ts" } }
          },
          delayMs: 800
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "reading-layout-read",
            result: "export const sample = true",
            isError: false
          },
          delayMs: 800
        },
        { chunk: { type: "text", text: readingLayoutContent } },
        { chunk: { type: "done", stopReason: "end_turn" } }
      ]
    };
    PROPOSED_INDEX_HTML = [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      "    <title>Sample</title>",
      '    <link rel="stylesheet" href="styles.css" />',
      "  </head>",
      "  <body>",
      "    <h1>Hello</h1>",
      "  </body>",
      "</html>",
      ""
    ].join("\n");
    PROPOSED_STYLES_CSS = ["h1 {", "  font-family: system-ui, sans-serif;", "}", ""].join("\n");
    PROPOSED_DIFF_TRACE = {
      id: "proposed-diff",
      label: "Proposed edits",
      prompt: "add a starter page and stylesheet",
      steps: [
        {
          chunk: {
            type: "text",
            text: "Adding a minimal page and the stylesheet it links to."
          }
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "tc-1",
              name: "write_file",
              args: { path: "index.html", content: PROPOSED_INDEX_HTML }
            }
          },
          delayMs: 700
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "tc-1",
            result: "Proposed index.html (+12)",
            isError: false
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "tool_call",
            toolCall: {
              id: "tc-2",
              name: "write_file",
              args: { path: "styles.css", content: PROPOSED_STYLES_CSS }
            }
          },
          delayMs: 700
        },
        {
          chunk: {
            type: "tool_result",
            toolCallId: "tc-2",
            result: "Proposed styles.css (+4)",
            isError: false
          },
          delayMs: 900
        },
        {
          chunk: {
            type: "text",
            text: "Both files are staged in **Changes** \u2014 review the diffs and accept or reject each one."
          }
        },
        { chunk: { type: "done", stopReason: "end_turn" }, delayMs: 300 }
      ]
    };
    SIDE_CHATS_THREADS = [
      {
        id: SIDE_CHATS_MAIN_ID,
        title: "Fix flaky mermaid e2e",
        status: "idle",
        gitBranch: "fix/mermaid-wait",
        model: "acp:claude-acp#sonnet",
        messages: [
          {
            id: "sc-user-1",
            role: "user",
            content: "The mermaid e2e spec fails about one run in five on CI. Any idea why?",
            toolCalls: [],
            createdAt: FIXED_TIME + 1e3
          },
          {
            id: "sc-assistant-1",
            role: "assistant",
            content: [
              "The spec asserts on the rendered svg right after navigation, but Mermaid renders",
              "asynchronously. See https://webdriver.io/docs/api/element/waitForDisplayed and the",
              `release thread copse://thread/${SIDE_CHATS_OTHER_ID}. Fix proposed in`,
              "https://github.com/acme/widgets/pull/42."
            ].join(" "),
            toolCalls: [
              {
                id: "sc-explore-call",
                name: "explore",
                args: { query: "waitForExist usages" },
                status: "done",
                result: "14 matches across 3 specs.",
                subagent: {
                  id: "sc-explore-session",
                  kind: "explore",
                  status: "done",
                  prompt: "Find every waitForExist on the mermaid selector",
                  summary: "14 matches across 3 specs.",
                  messages: [],
                  model: "acp:claude-acp#haiku"
                }
              }
            ],
            createdAt: FIXED_TIME + 2e3
          }
        ],
        prRefs: [
          {
            owner: "acme",
            repo: "widgets",
            number: 42,
            url: "https://github.com/acme/widgets/pull/42"
          }
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME + 5e3
      },
      {
        id: "sc-side-1",
        title: "waitForExist vs waitForDisplayed",
        status: "idle",
        model: "acp:codex-acp#fast",
        sideChat: { parentThreadId: SIDE_CHATS_MAIN_ID, anchorMessageId: "sc-assistant-1" },
        unreadAt: FIXED_TIME + 4e3,
        messages: [
          {
            id: "sc-side1-user",
            role: "user",
            content: "What is the difference between waitForExist and waitForDisplayed here?",
            toolCalls: [],
            createdAt: FIXED_TIME + 3100
          },
          {
            id: "sc-side1-assistant",
            role: "assistant",
            content: [
              "They wait for different things:",
              "",
              "- **`waitForExist`** only checks that the node is in the DOM.",
              "- **`waitForDisplayed`** also needs a non-zero size and no `display: none`.",
              "",
              "Mermaid inserts an empty svg first, so the first one passes too early."
            ].join("\n"),
            toolCalls: [],
            createdAt: FIXED_TIME + 3900
          }
        ],
        prRefs: [],
        links: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME + 3e3,
        updatedAt: FIXED_TIME + 4e3
      },
      {
        id: "sc-side-2",
        title: "Is this safe to merge?",
        status: "idle",
        model: "acp:claude-acp#sonnet",
        sideChat: { parentThreadId: SIDE_CHATS_MAIN_ID, anchorMessageId: "sc-user-1" },
        archivedAt: FIXED_TIME + 4500,
        messages: [],
        messagesLoaded: false,
        prRefs: [],
        links: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME + 2500,
        updatedAt: FIXED_TIME + 4500
      },
      {
        id: SIDE_CHATS_OTHER_ID,
        title: "Release notes draft",
        status: "idle",
        messages: [
          {
            id: "sc-other-1",
            role: "user",
            content: `Include the mermaid fix from copse://thread/${SIDE_CHATS_MAIN_ID}.`,
            toolCalls: [],
            createdAt: FIXED_TIME
          }
        ],
        prRefs: [],
        links: [{ kind: "thread", target: SIDE_CHATS_MAIN_ID }],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME + 1e3
      }
    ];
    SIDE_CHAT_RICH_THREADS = SIDE_CHATS_THREADS.map(
      (thread) => thread.id === "sc-side-1" ? {
        ...thread,
        title: "Why does the wait matter?",
        messages: [
          {
            id: "sc-rich-user",
            role: "user",
            content: "Why does the wait matter?\nDraw the sequence.",
            toolCalls: [],
            createdAt: FIXED_TIME + 3100
          },
          {
            id: "sc-rich-assistant",
            role: "assistant",
            content: [
              "The svg only exists after Mermaid finishes:",
              "",
              "```mermaid",
              "graph TD",
              "  A[Navigate] --> B[Empty svg]",
              "  B --> C[Rendered diagram]",
              "```",
              "",
              "| Wait | Passes on |",
              "| --- | --- |",
              "| waitForExist | Empty svg |",
              "| waitForDisplayed | Rendered diagram |",
              "",
              "```ts",
              "await $('.mermaid svg').waitForDisplayed()",
              "```"
            ].join("\n"),
            toolCalls: [],
            createdAt: FIXED_TIME + 3900
          }
        ]
      } : thread
    );
    DEMO_SCENARIOS = [
      // The first scenario remains the marketing landing walkthrough.
      {
        // First, so a bare `/demo/<branch>/` opens on the walkthrough rather than a
        // visual-test fixture. It is also what the marketing hero iframe embeds.
        id: "landing",
        label: "Builds a cupcake site",
        project: project("demo-landing-project", "Crumb & Bloom", "/demo/crumb-and-bloom"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          model: LANDING_TRACE.source?.model ?? "claude-opus-5",
          registeredAcpAgents: [DEMO_CODEX_ACP_AGENT],
          layout: {
            projectsPaneWidth: 240,
            filesPaneWidth: 640,
            filesPaneHeight: 360,
            fileTreeWidth: 140
          }
        },
        threads: [
          {
            // Empty on purpose: the walkthrough types the prompt into the composer,
            // so the transcript builds from nothing while you watch.
            id: "demo-landing-thread",
            title: "Crumb & Bloom coming soon",
            status: "idle",
            gitBranch: "main",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        trace: LANDING_TRACE,
        deferProposedDiffPreview: true,
        staticSite: "sites/cupcakes",
        revealFinalPreview: true
      },
      {
        // Exercises the proposed-diff path end to end: the replayed `write_file`
        // calls travel the same route a real edit does (demo-api → `agent:show-diff`
        // → Changes panel), so this fixture fails if that wiring breaks.
        //
        // Hand-written, unlike `landing`: it is a fixture for a panel state, not a
        // recording of a turn that happened. `DEMO_TRACE` provenance rules apply to
        // `demo-traces/`, not to fixtures declared here.
        id: "proposed-diff",
        label: "Agent-proposed edits open the Changes panel",
        project: project("demo-proposed-diff-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-proposed-diff-thread",
            title: "Proposed edits",
            status: "idle",
            gitBranch: "main",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        trace: PROPOSED_DIFF_TRACE
      },
      {
        id: "chat-reading-layout",
        label: "Readable assistant responses",
        project: project("demo-reading-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-reading-thread",
            title: "Readable assistant responses",
            status: "idle",
            messages: [
              {
                id: "demo-reading-user",
                role: "user",
                content: "Show an answer with paragraphs, lists, and code.",
                toolCalls: [],
                createdAt: FIXED_TIME
              },
              {
                id: "demo-reading-assistant",
                role: "assistant",
                content: readingLayoutContent,
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        trace: READING_LAYOUT_TRACE
      },
      {
        id: "markdown-list-indent",
        label: "Markdown list indentation",
        project: project("demo-markdown-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-markdown-thread",
            title: "Markdown list indentation",
            status: "idle",
            messages: [
              {
                id: "demo-markdown-assistant",
                role: "assistant",
                content: markdownContent,
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "container-run",
        label: "Unattended container run",
        project: project("demo-container-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          model: "claude-sonnet-4-6",
          containerRunsEnabled: true
        },
        threads: [
          {
            id: "demo-container-thread",
            title: "Clear the lint backlog",
            status: "idle",
            gitBranch: "demo/lint-backlog",
            messages: [
              {
                id: "demo-container-user",
                role: "user",
                content: "Clear the lint backlog and open a PR.",
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 412310, outputTokens: 38902 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        containerRun: {
          threadId: "demo-container-thread",
          runtimeId: "run-demo-1",
          phase: "finished",
          startedAt: FIXED_TIME,
          finishedAt: FIXED_TIME + 23 * 6e4,
          prompt: "Clear the lint suppression backlog in the renderer views",
          model: "claude-sonnet-4-6",
          egressAllowlist: ["inference.copse.internal:443"],
          credential: "host",
          settings: {
            budgets: { wallClockMs: 18e4, tokenCeiling: 2e4 },
            installDependencies: false
          },
          warnings: [],
          checkout: {
            root: "/Users/dev/projects/demo/.copse/worktrees/demo-container-thread",
            mode: "worktree",
            branch: "demo/lint-backlog"
          },
          log: [
            "[thread-container] carry-in 9b1b901683b9 as refs/copse/carry-in/run-demo-1",
            "[thread-container] starting copse-run-demo-1 from copse-worker:local",
            "[guest] [worker] egress proxy on 127.0.0.1:3128, token-gated",
            "[guest] [worker] project sandbox: none; the container is the sandbox",
            "[guest] [worker] done: completed; prompts=0 deferrals=1 commits=3",
            "[thread-container] carry-out fetched to refs/copse/runs/run-demo-1"
          ],
          record: {
            runtimeId: "run-demo-1",
            threadId: "demo-container-thread",
            startedAt: FIXED_TIME,
            finishedAt: FIXED_TIME + 23 * 6e4,
            image: "copse-worker:local",
            imageDigest: "sha256:0c1f2e3d4c5b6a798877665544332211aabbccddeeff00112233445566778899",
            attestation: {
              runtimeId: "run-demo-1",
              image: "copse-worker:local",
              user: 1001,
              readOnlyRootfs: true,
              capDropAll: true,
              noNewPrivileges: true,
              pidsLimit: 512,
              memoryLimit: "4g",
              network: "brokered",
              egressAllowlist: ["inference.copse.internal:443"],
              hostMounts: ["/run/copse", "/run/copse/state", "/run/copse/out"]
            },
            egress: [{ at: FIXED_TIME, origin: "inference.copse.internal:443", event: "connect" }],
            result: {
              threadId: "demo-container-thread",
              stopReason: "completed",
              usage: { inputTokens: 412310, outputTokens: 38902 },
              harness: "copse",
              promptsAttempted: 0,
              denials: [],
              deferrals: [
                {
                  id: "d1",
                  title: "Outward effect needs review",
                  subject: "shell command (arguments omitted)",
                  reasons: ["git push publishes commits to a remote"]
                }
              ],
              commits: [
                "a1b2c3d fix(lint): remove unused imports across src/main",
                "b2c3d4e fix(lint): prefer nullish coalescing in providers",
                "c3d4e5f chore: rerun formatter"
              ],
              containment: { declared: true, declineReason: null, projectSandbox: false },
              toolNames: ["run_shell", "read_file", "write_file"],
              finalText: "Cleared the lint backlog in three commits. The push is waiting for your review."
            },
            transcript: [
              {
                id: "guest-1",
                role: "assistant",
                content: "Reading the lint report to see which suppressions are still needed.",
                toolCalls: [
                  {
                    id: "guest-t1",
                    name: "run_shell",
                    args: { command: "pnpm run lint -- --format json" },
                    status: "done",
                    result: "14 suppressions, 11 of them for rules that no longer fire"
                  },
                  {
                    id: "guest-t2",
                    name: "str_replace",
                    args: { path: "src/main/providers/openai.ts" },
                    status: "done",
                    result: "Replaced 1 occurrence",
                    editStats: { additions: 1, deletions: 3 }
                  }
                ],
                createdAt: FIXED_TIME + 6e4
              },
              {
                id: "guest-2",
                role: "assistant",
                content: "Cleared the lint backlog in three commits. The push is waiting for your review.",
                toolCalls: [],
                createdAt: FIXED_TIME + 22 * 6e4
              }
            ],
            carryIn: { sha: "9b1b901683b9f0e5b2a3c4d5e6f708192a3b4c5d", dirty: false },
            carryOut: { expected: true, ref: "refs/copse/runs/run-demo-1", error: null },
            containerExit: 0,
            credential: "host",
            teardown: "removed",
            cleanupError: null,
            secretCanary: { present: false, detail: "canary absent from every surface" }
          },
          error: null,
          continuedFrom: null
        }
      },
      {
        id: "balanced-model-label",
        label: "Balanced model rule label",
        trace: {
          id: "balanced-model-resolution",
          label: "Balanced resolves before the first token",
          prompt: "Show the concrete model for this turn.",
          steps: [
            {
              chunk: {
                type: "turn_parameters",
                model: "claude-sonnet-4-6",
                parameters: {},
                requestedModel: "auto:balanced"
              }
            },
            { delayMs: 5e3, chunk: { type: "text", text: "This turn runs on Claude Sonnet 4.6." } },
            { chunk: { type: "done", stopReason: "end_turn" } }
          ]
        },
        project: project("demo-balanced-model-label-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          model: "auto:balanced"
        },
        threads: [
          {
            id: "demo-balanced-model-label-thread",
            title: "Balanced model label",
            status: "idle",
            model: "auto:balanced",
            messages: [
              {
                id: "demo-balanced-model-label-user",
                role: "user",
                content: "Keep this conversation on the balanced model rule.",
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "prompt-model-first-ask",
        label: "Prompt matching without transcript diagnostics",
        trace: {
          id: "prompt-model-first-ask",
          label: "The first ask pins the model in the picker",
          prompt: "Check for typos in the README",
          steps: [
            {
              chunk: {
                type: "turn_parameters",
                model: "claude-haiku-4-5",
                parameters: {},
                requestedModel: "auto:match-prompt"
              }
            },
            { delayMs: 2e3, chunk: { type: "text", text: "I\u2019ll check the README for typos." } },
            { chunk: { type: "done", stopReason: "end_turn" } }
          ]
        },
        project: project("demo-prompt-model-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          model: "auto:match-prompt"
        },
        threads: [
          {
            id: "demo-prompt-model-thread",
            title: "README typo check",
            status: "idle",
            model: "auto:match-prompt",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "footer-compact",
        label: "Responsive composer footer",
        project: project("demo-footer-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          model: "lmstudio:qwen/qwen3.6-35b-a3b",
          // Copy/export overflow actions are developer-mode gated; the geometry
          // demo needs them visible to exercise `.footer-overflow`.
          developerMode: true,
          containerRunsEnabled: true
        },
        threads: [
          {
            id: "demo-footer-thread",
            title: "Footer compact layout",
            status: "idle",
            gitBranch: "demo/responsive-footer-layout",
            messages: [
              {
                id: "demo-footer-user",
                role: "user",
                content: "Check footer layout at narrow widths.",
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: FOOTER_INPUT_TOKENS, outputTokens: FOOTER_OUTPUT_TOKENS },
            contextSnapshot: {
              contextWindow: 2e5,
              conversationBudget: 18e4,
              conversationTokens: 9e3,
              fillRatio: 0.05,
              updatedAt: FIXED_TIME
            },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "subagent-display",
        label: "Subagent display visual reference",
        project: project("demo-subagent-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-subagent-thread",
            title: "Subagent display test",
            status: "idle",
            messages: [
              {
                id: "demo-subagent-assistant",
                role: "assistant",
                content: "Here is what the subagent found.",
                toolCalls: [
                  {
                    id: "demo-explore-call",
                    name: "explore",
                    args: { query: "Find README" },
                    status: "done",
                    result: "README describes Copse setup and dev workflow.",
                    subagent: {
                      id: "demo-explore-session",
                      kind: "explore",
                      status: "done",
                      prompt: "Find README",
                      summary: "README describes Copse setup and dev workflow.",
                      messages: [
                        {
                          id: "demo-explore-message-1",
                          role: "assistant",
                          content: "Reading **README.md** for project overview.",
                          toolCalls: [
                            {
                              id: "demo-inner-read",
                              name: "read_file",
                              args: { path: "README.md" },
                              status: "done",
                              result: "# Copse\n"
                            }
                          ]
                        },
                        {
                          id: "demo-explore-message-2",
                          role: "assistant",
                          content: "README describes Copse setup and dev workflow.",
                          toolCalls: []
                        }
                      ]
                    }
                  },
                  {
                    id: "demo-custom-agent-call",
                    name: "task",
                    args: {
                      subagent_type: "security-reviewer",
                      prompt: "Review the authentication changes for security regressions."
                    },
                    status: "done",
                    result: "No authentication bypasses found.",
                    subagent: {
                      id: "demo-custom-agent-session",
                      kind: "custom",
                      status: "done",
                      prompt: "Review the authentication changes for security regressions.",
                      summary: "No authentication bypasses found.",
                      model: "claude-opus-4-8",
                      agentName: "security-reviewer",
                      agentColor: "#c084fc",
                      messages: [
                        {
                          id: "demo-custom-agent-message-1",
                          role: "assistant",
                          content: "No authentication bypasses found.",
                          toolCalls: []
                        }
                      ]
                    }
                  }
                ],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        // #728: a subagent-backed explore must stay its own card when a sibling
        // read_file would otherwise fold both into a "Read files" group.
        id: "subagent-ungrouped",
        label: "Subagent stays ungrouped beside reading tools",
        project: project("demo-subagent-ungrouped-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-subagent-ungrouped-thread",
            title: "Subagent ungrouped",
            status: "idle",
            messages: [
              {
                id: "demo-subagent-ungrouped-assistant",
                role: "assistant",
                content: "Explored the repo and read the README.",
                toolCalls: [
                  {
                    id: "demo-ungrouped-explore",
                    name: "explore",
                    args: { query: "Find README" },
                    status: "done",
                    result: "README describes Copse setup.",
                    subagent: {
                      id: "demo-ungrouped-session",
                      kind: "explore",
                      status: "done",
                      prompt: "Find README",
                      summary: "README describes Copse setup.",
                      messages: [
                        {
                          id: "demo-ungrouped-msg",
                          role: "assistant",
                          content: "Found **README.md**.",
                          toolCalls: []
                        }
                      ]
                    }
                  },
                  {
                    id: "demo-ungrouped-read",
                    name: "read_file",
                    args: { path: "README.md" },
                    status: "done",
                    result: "# Copse\n"
                  }
                ],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "semantic-search-markdown",
        label: "Semantic search subagent markdown",
        project: project("demo-semantic-search-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-semantic-search-thread",
            title: "Mechanism Explained",
            status: "idle",
            messages: [
              {
                id: "demo-semantic-user",
                role: "user",
                content: "is there semantic search",
                toolCalls: [],
                createdAt: FIXED_TIME
              },
              {
                id: "demo-semantic-assistant",
                role: "assistant",
                content: "Good find \u2014 there *is* semantic search in the agent's code search routing. Let me explore it.",
                toolCalls: [
                  {
                    id: "demo-semantic-explore",
                    name: "explore",
                    args: { query: "How is semantic search routed?" },
                    status: "done",
                    result: semanticSearchSummary,
                    subagent: {
                      id: "demo-semantic-session",
                      kind: "explore",
                      status: "done",
                      prompt: "How is semantic search routed?",
                      summary: semanticSearchSummary,
                      messages: [
                        {
                          id: "demo-semantic-summary",
                          role: "assistant",
                          content: semanticSearchSummary,
                          toolCalls: []
                        }
                      ]
                    }
                  }
                ],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "approval-thread-switch-scroll",
        label: "Switch between threads awaiting permission",
        project: project("demo-approval-scroll-project"),
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off" },
        threads: ["a", "b"].map((suffix) => ({
          id: `demo-approval-scroll-${suffix}`,
          title: `Permission wait ${suffix.toUpperCase()}`,
          status: "running",
          messages: Array.from({ length: 20 }, (_, index) => ({
            id: `approval-scroll-${suffix}-${String(index)}`,
            role: index % 2 === 0 ? "user" : "assistant",
            content: index === 19 ? `The checks are ready. I need permission to run command ${suffix.toUpperCase()}.` : index % 2 === 0 ? `Review step ${String(index / 2 + 1)} for thread ${suffix.toUpperCase()}.` : "I checked the relevant code and recorded the result. The next check will confirm the remaining behavior.",
            toolCalls: index === 19 ? [
              {
                id: `approval-scroll-tool-${suffix}`,
                name: "run_shell",
                args: { command: `node scripts/check-${suffix}.mjs` },
                status: "running",
                result: ""
              }
            ] : [],
            createdAt: FIXED_TIME + index
          })),
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME
        })),
        approvalRequests: ["a", "b"].map((suffix) => ({
          id: `approval-scroll-request-${suffix}`,
          threadId: `demo-approval-scroll-${suffix}`,
          title: "Run outside sandbox?",
          body: `node scripts/check-${suffix}.mjs`,
          bodyFooter: "Allow running it once outside the sandbox?",
          type: "shell"
        }))
      },
      {
        id: "approval-light-accent",
        label: "Light-theme approval with a bright accent",
        project: project("demo-approval-light-accent-project"),
        settings: {
          onboardingCompleted: true,
          theme: "light",
          uiAccentColor: "#20FD85",
          uiTintColor: "#244C25",
          uiTintStrength: "subtle"
        },
        threads: [
          {
            id: "demo-approval-light-accent-thread",
            title: "Approval contrast",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        approvalRequests: [
          {
            id: "demo-approval-light-accent-request",
            title: "Run outside sandbox?",
            body: "npm install",
            bodyAdvice: "The project sandbox would block this command:\n\u2022 Installs or updates packages, which downloads and runs code from the internet",
            bodyFooter: "Allow running it once outside the sandbox?",
            type: "shell"
          }
        ]
      },
      {
        // Companion to `approval-light-accent`: same bright accent, same light theme,
        // but aimed at the surfaces issue #2486/#2488/#2483 reported rather than the
        // approval dialog. The accent matters — light derives `--accent` as 30% of it
        // mixed with black, so a bright one makes the derived tier unmistakably dark
        // and any control that fills with it instead of `--accent-fill` shows up.
        id: "light-contrast-surfaces",
        label: "Light-theme syntax, fills, and selection",
        project: project("demo-light-contrast-project"),
        settings: {
          onboardingCompleted: true,
          theme: "light",
          uiAccentColor: "#20FD85",
          uiTintColor: "#244C25",
          uiTintStrength: "subtle"
        },
        threads: [
          {
            id: "demo-light-contrast-thread",
            title: "Light-theme contrast",
            status: "idle",
            messages: [
              {
                id: "demo-light-contrast-assistant",
                role: "assistant",
                content: syntaxContrastContent,
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "approval-grouped-shell-commands",
        label: "Grouped outside-sandbox command approval",
        project: project("demo-approval-grouped-shell-commands-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-approval-grouped-shell-commands-thread",
            title: "Measuring oracle execution time",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        approvalRequests: [
          {
            id: "demo-approval-grouped-shell-commands-oracle",
            title: "Run outside sandbox?",
            body: "node .tmp/dep-candidates.mjs",
            bodyAdvice: "The project sandbox would block this command:\n\u2022 Runs a script file from the project, so Copse can't tell what it does\n\nThis runs with your user account\u2019s access to files and the network, beyond the project sandbox.",
            bodyFooter: "Allow running it once outside the sandbox?",
            type: "shell"
          },
          {
            id: "demo-approval-grouped-shell-commands-syntax",
            title: "Run outside sandbox?",
            body: "mkdir -p node_modules && ln -s ../.tmp/validation/node_modules.partial/.pnpm/esbuild@0.28.2/node_modules/esbuild node_modules/esbuild",
            bodyAdvice: "The project sandbox would block this command:\n\u2022 Reaches outside the project with a ../ path\n\nThis runs with your user account\u2019s access to files and the network, beyond the project sandbox.",
            bodyFooter: "Allow running it once outside the sandbox?",
            type: "shell"
          },
          {
            id: "demo-approval-grouped-shell-commands-test",
            title: "Run outside sandbox?",
            body: "ln -s ../.tmp/validation/node_modules.partial/.pnpm/esbuild@0.28.2/node_modules/esbuild node_modules/esbuild",
            bodyAdvice: "The project sandbox would block this command:\n\u2022 Reaches outside the project with a ../ path\n\nThis runs with your user account\u2019s access to files and the network, beyond the project sandbox.",
            bodyFooter: "Allow running it once outside the sandbox?",
            type: "shell"
          }
        ]
      },
      {
        id: "approval-long-code",
        label: "Long code command approval",
        project: project("demo-approval-long-code-project"),
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off" },
        threads: [
          {
            id: "demo-approval-long-code-thread",
            title: "Review the generated script",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        approvalRequests: [
          {
            id: "demo-approval-long-code-request",
            title: "Run outside sandbox?",
            body: [
              "node <<'SCRIPT'",
              ...Array.from(
                { length: 40 },
                (_, index) => `console.log('Checking generated source line ${String(index + 1)}')`
              ),
              "SCRIPT"
            ].join("\n"),
            bodyAdvice: "The project sandbox would block this command:\n\u2022 Runs generated code from standard input, so Copse cannot inspect the resulting file accesses\n\nThis runs with your user account\u2019s access to files and the network, beyond the project sandbox.",
            bodyFooter: "Allow running this code once outside the sandbox?",
            type: "shell"
          }
        ]
      },
      {
        id: "approval-mixed-prose-code",
        label: "Approval with paragraphs and code blocks",
        project: project("demo-approval-mixed-prose-code-project"),
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off" },
        threads: [
          {
            id: "demo-approval-mixed-prose-code-thread",
            title: "Review the project setup",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        approvalRequests: [
          {
            id: "demo-approval-mixed-prose-code-setup",
            title: "Run setup script?",
            body: "node <<'SCRIPT'\nconst packages = ['core', 'ui']\nconsole.log(packages.join(', '))\nSCRIPT",
            bodyAdvice: "The setup script checks local dependencies.\n\nIt runs generated JavaScript, so Copse cannot determine every file it may access.",
            bodyFooter: "Allow the setup script to run once?",
            type: "shell"
          },
          {
            id: "demo-approval-mixed-prose-code-preview",
            title: "Preview migration?",
            body: "node <<'SCRIPT'\nconst changes = ['add index', 'copy rows']\nconsole.log(changes.join('\\n'))\nSCRIPT",
            bodyAdvice: "The migration preview reads project data and prints the planned changes.\n\nIt opens a local resource outside the project sandbox.",
            bodyFooter: "Allow the migration preview to run once?",
            type: "shell"
          },
          {
            id: "demo-approval-mixed-prose-code-apply",
            title: "Apply generated patch?",
            body: "node <<'SCRIPT'\nconst target = 'src/generated/index.ts'\nconsole.log('Writing', target)\nSCRIPT",
            bodyAdvice: "The final step writes the generated patch into the project.\n\nReview the target before allowing this command to run.",
            bodyFooter: "Allow the patch command to run once?",
            type: "shell"
          }
        ]
      },
      {
        id: "product-announcements-fresh",
        label: "Product announcements \u2014 fresh",
        project: project("demo-announcements-project"),
        settings: { onboardingCompleted: false, theme: "dark", acknowledgedProductAnnouncements: [] },
        threads: [
          {
            id: "demo-announcements-thread",
            title: "Polish the release",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        // The real shipped catalog (not sample copy) for an existing profile.
        id: "product-announcements-shipped",
        label: "Product announcements \u2014 shipped catalog",
        project: project("demo-announcements-project"),
        settings: { onboardingCompleted: true, theme: "dark", acknowledgedProductAnnouncements: [] },
        threads: [
          {
            id: "demo-announcements-thread",
            title: "Polish the release",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "product-announcements-existing",
        label: "Product announcements \u2014 existing",
        project: project("demo-announcements-project"),
        settings: { onboardingCompleted: true, theme: "dark", acknowledgedProductAnnouncements: [] },
        threads: [
          {
            id: "demo-announcements-thread",
            title: "Polish the release",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "product-announcements-update",
        label: "Product announcements \u2014 update",
        project: project("demo-announcements-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          acknowledgedProductAnnouncements: ["demo-compact-released"]
        },
        threads: [
          {
            id: "demo-announcements-thread",
            title: "Polish the release",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "product-announcements-seen",
        label: "Product announcements \u2014 seen",
        project: project("demo-announcements-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          acknowledgedProductAnnouncements: ["demo-compact-released", "demo-announcements-ready"]
        },
        threads: [
          {
            id: "demo-announcements-thread",
            title: "Polish the release",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "update-prompt-changelog",
        label: "Update prompt listing every missed release",
        project: project("demo-update-prompt-changelog-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-update-prompt-changelog-thread",
            title: "Weekly release cadence",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        updatePromptRequests: [
          {
            id: "demo-update-prompt-changelog",
            message: "Copse 0.1.0-beta.11 is available",
            detail: "Download the update now? You can install it immediately once downloaded.",
            changelog: [
              {
                version: "0.1.0-beta.11",
                notes: [
                  "- The Browser pane restores its tabs when Copse is reopened.",
                  "- Tool calls that miss a numeric bound run at the cap instead of failing.",
                  "",
                  "## Known issues",
                  "",
                  "- Restored tabs do not keep their scroll position."
                ].join("\n")
              },
              {
                version: "0.1.0-beta.10",
                // Release notes arrive over the network: markup must render inert.
                notes: '- Faster `find_files` on large repositories.\n- <img src="x" onerror="document.body.dataset.pwned=1"><script>document.body.dataset.pwned=1<\/script>Hardened update checks.'
              },
              { version: "0.1.0-beta.9", notes: "" }
            ],
            changelogUrl: "https://github.com/copse-dev/copse-releases/releases",
            buttons: ["Download", "Later"],
            defaultIndex: 0,
            cancelIndex: 1
          }
        ]
      },
      {
        id: "vnc-discovered-ports",
        label: "Remote desktop discovered-port list with one selected",
        project: project("demo-vnc-discovered-ports-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          vncEnabled: true
        },
        threads: [
          {
            id: "demo-vnc-discovered-ports-thread",
            title: "Remote desktop",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        vncDiscoveredPorts: [5900, 5901, 5902]
      },
      {
        id: "vnc-saved-login",
        label: "Remote desktop device with a saved login in a narrow rail",
        project: project("demo-vnc-saved-login-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          vncEnabled: true
        },
        threads: [
          {
            id: "demo-vnc-saved-login-thread",
            title: "Remote desktop",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        vncDiscoveredPorts: [5900],
        vncSavedLogin: { username: "saved-user" }
      },
      {
        id: "inline-thread-reference",
        label: "Inline thread reference chip geometry",
        project: project("demo-inline-thread-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-inline-thread-active",
            title: "Compare thread context",
            status: "idle",
            messages: [
              {
                id: "demo-inline-thread-user",
                role: "user",
                content: "Earlier: \uFFFC confirmed the current outline.",
                attachments: [{ kind: "thread", label: "Existing thread reference" }],
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          },
          {
            id: "demo-inline-thread-reference",
            title: "TypeSafe inference",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 6e4,
            updatedAt: FIXED_TIME - 6e4
          }
        ]
      },
      {
        id: "settings-footer",
        label: "Settings scroll + sticky footer geometry",
        project: project("demo-settings-footer-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        mobileCompanion: { url: MOBILE_COMPANION_DEMO_URL, qrSvg: MOBILE_COMPANION_DEMO_QR_SVG },
        threads: [
          {
            id: "demo-settings-footer-thread",
            title: "Settings footer",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "plugin-install-review",
        label: "Plugin catalogue install review",
        project: project("demo-plugin-install-review-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-plugin-install-review-thread",
            title: "Plugin install review",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        // The Figma package as reviewed at its pinned catalogue revision.
        pluginInstallReview: {
          token: "demo-plugin-install-review",
          catalogId: "https://github.com/figma/mcp-server-guide#",
          pluginId: "figma",
          name: "figma",
          description: "Figma design platform integration. Access design files, extract component information, read design tokens, and translate designs into code.",
          publisher: "figma",
          contentHash: "sha256:3e8e1e7aecedae788bc34903a3708818d3f161ea381583084e971a2804c298a3",
          revision: "172920731eedf414e9b22ae60017d9a5b6c9f81f",
          skillCount: 14,
          mcpServerCount: 1,
          skills: [
            "skills/figma-code-connect/SKILL.md",
            "skills/figma-create-new-file/SKILL.md",
            "skills/figma-design-to-code/SKILL.md",
            "skills/figma-generate-design/SKILL.md",
            "skills/figma-generate-diagram/SKILL.md",
            "skills/figma-generate-library/SKILL.md",
            "skills/figma-generative-plugins/SKILL.md",
            "skills/figma-implement-motion/SKILL.md",
            "skills/figma-shaders/SKILL.md",
            "skills/figma-swiftui/SKILL.md",
            "skills/figma-use-figjam/SKILL.md",
            "skills/figma-use-motion/SKILL.md",
            "skills/figma-use-slides/SKILL.md",
            "skills/figma-use/SKILL.md"
          ],
          mcpServers: [
            { name: "figma", transport: "streamable-http", target: "https://mcp.figma.com/mcp" }
          ],
          warnings: [
            `MCP server "figma" won't connect: Figma only admits MCP apps it has approved, and Copse isn't one yet. The skills still work.`
          ],
          provenance: "unsigned",
          operation: "install"
        }
      },
      {
        id: "mcp-sign-in",
        label: "MCP servers that sign in with OAuth",
        project: project("demo-mcp-sign-in-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-mcp-sign-in-thread",
            title: "MCP sign-in",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        mcpServers: [
          {
            name: "design-system",
            transport: "http",
            state: "error",
            error: "Sign-in required",
            auth: "required",
            toolCount: 0,
            tools: [],
            origin: "user",
            source: "/Users/demo/.cursor/mcp.json",
            originDetail: "mcp.json",
            userEnabled: true,
            configDisabled: false
          },
          {
            name: "issues",
            transport: "http",
            state: "connected",
            auth: "signed-in",
            toolCount: 3,
            tools: ["list_issues", "get_issue", "create_issue"],
            origin: "user",
            source: "/Users/demo/.cursor/mcp.json",
            originDetail: "mcp.json",
            userEnabled: true,
            configDisabled: false
          }
        ]
      },
      {
        id: "automation-permissions",
        label: "Automation permission preferences",
        project: project("demo-automation-permissions-project", "Copse", "/demo/copse"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-automation-permissions-thread",
            title: "Automation permissions",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        // Per-model generation parameters. The scenario only has to seed the chat
        // model and its saved parameters — open Settings → General → Models in the
        // preview and the section renders itself against that selection. Uses an
        // OpenRouter model so all three controls are offered (a current Claude model
        // would show the reasoning ladder alone).
        id: "model-parameters",
        label: "Per-model reasoning / temperature / top-p",
        project: project("demo-model-parameters-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          model: "openrouter:deepseek/deepseek-v4-flash-0731",
          modelParameters: {
            "openrouter:deepseek/deepseek-v4-flash-0731": {
              reasoning: "max",
              temperature: 1,
              topP: 0.95
            },
            "claude-opus-5": { reasoning: "xhigh" }
          }
        },
        threads: [
          {
            id: "demo-model-parameters-thread",
            title: "Model parameters",
            status: "idle",
            // A thread-level dial so the composer footer shows its set state
            // alongside the Settings block.
            model: "claude-opus-5",
            reasoning: "max",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "thread-hydration",
        label: "Thread switch hydration notice",
        project: project("demo-thread-hydration-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // The state under test is the moment after selecting a thread whose
        // transcript has not been read yet while its agent run is still going:
        // metadata only, no messages, status running. holdThreadHydration keeps
        // the loading notice on screen instead of letting it resolve instantly.
        holdThreadHydration: true,
        threads: [
          {
            id: "demo-thread-hydration-thread",
            title: "Long refactor still running",
            status: "running",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "thread-hydration-failed",
        label: "Thread switch hydration failure",
        project: project("demo-thread-hydration-failed-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // Same mid-switch moment as `thread-hydration`, but the transcript read
        // rejects: the pane must render the honest failure line and let the live
        // activity row through (the agent is still running).
        failThreadHydration: true,
        threads: [
          {
            id: "demo-thread-hydration-failed-thread",
            title: "Long refactor still running",
            status: "running",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "apple-development",
        label: "Apple Development test profile",
        project: project("demo-apple-development-project", "DemoApp", "/demo/DemoApp"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-apple-development-thread",
            title: "Apple Development demo",
            status: "idle",
            messages: [
              {
                id: "demo-apple-user",
                role: "user",
                content: "Build and test DemoApp on the selected iPhone Simulator.",
                toolCalls: [],
                createdAt: FIXED_TIME
              },
              {
                id: "demo-apple-assistant",
                role: "assistant",
                content: "The panel shows the latest Apple Development operation for this thread.",
                toolCalls: [],
                createdAt: FIXED_TIME + 1
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME + 4e3
          }
        ],
        appleDevelopmentState: {
          pluginEnabled: true,
          enrolled: true,
          supportedHost: true,
          toolchain: {
            developerDir: "/Applications/Xcode.app/Contents/Developer",
            version: "Xcode 26.6"
          },
          candidates: [
            {
              id: "ios/DemoApp.xcworkspace",
              name: "ios/DemoApp",
              kind: "workspace",
              schemes: ["DemoApp"]
            }
          ],
          destinations: [
            {
              id: "platform=iOS Simulator,id=E2E-IP17-PRO",
              name: "iPhone 17 Pro",
              platform: "iOS Simulator",
              supported: true,
              booted: true
            }
          ],
          metadataRequiresExecution: false,
          selection: {
            candidateId: "ios/DemoApp.xcworkspace",
            schemeId: "DemoApp",
            configuration: "Debug",
            destinationId: "platform=iOS Simulator,id=E2E-IP17-PRO",
            revision: 1
          },
          operations: [
            {
              id: "run-demo",
              action: "run",
              status: "cancelled",
              target: {
                candidateId: "ios/DemoApp.xcworkspace",
                schemeId: "DemoApp",
                configuration: "Debug",
                destinationId: "platform=iOS Simulator,id=E2E-IP17-PRO",
                revision: 1
              },
              createdAt: FIXED_TIME + 3e3,
              updatedAt: FIXED_TIME + 4e3,
              outcome: {
                operationId: "run-demo",
                status: "cancelled",
                reason: "Cancelled while waiting for the selected Simulator.",
                exitCode: null,
                diagnostics: [],
                testSummary: null,
                logArtifactId: "apple-log:run-demo",
                outputTruncated: false
              }
            },
            {
              id: "test-demo",
              action: "test",
              status: "failed",
              target: {
                candidateId: "ios/DemoApp.xcworkspace",
                schemeId: "DemoApp",
                configuration: "Debug",
                destinationId: "platform=iOS Simulator,id=E2E-IP17-PRO",
                revision: 1
              },
              createdAt: FIXED_TIME + 2e3,
              updatedAt: FIXED_TIME + 3e3,
              outcome: {
                operationId: "test-demo",
                status: "failed",
                reason: "DemoAppTests failed with 1 failing test.",
                exitCode: 65,
                diagnostics: [],
                testSummary: { passed: 42, failed: 1, skipped: 2 },
                logArtifactId: "apple-log:test-demo",
                outputTruncated: false
              }
            },
            {
              id: "build-demo",
              action: "build",
              status: "succeeded",
              target: {
                candidateId: "ios/DemoApp.xcworkspace",
                schemeId: "DemoApp",
                configuration: "Debug",
                destinationId: "platform=iOS Simulator,id=E2E-IP17-PRO",
                revision: 1
              },
              createdAt: FIXED_TIME + 1e3,
              updatedAt: FIXED_TIME + 2e3,
              outcome: {
                operationId: "build-demo",
                status: "succeeded",
                exitCode: 0,
                diagnostics: [],
                testSummary: null,
                logArtifactId: "apple-log:build-demo",
                outputTruncated: false
              }
            }
          ],
          setupMessage: null
        }
      },
      {
        id: "sidebar-automation-fold",
        label: "Sidebar automation fold",
        project: project("demo-automation-fold-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // One schedule with every kind of run: four waiting on the user (collapsed into one
        // row), one working, two failed (collated), and three that finished cleanly.
        // The regular thread comes first so it is the open one: a selected run would unfold its schedule.
        threads: [
          {
            id: "demo-automation-fold-chat",
            title: "A regular conversation",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME + 1,
            updatedAt: FIXED_TIME + 1
          },
          ...[
            ["wait-1", "idle"],
            ["wait-2", "idle"],
            ["wait-3", "idle"],
            ["wait-4", "idle"],
            ["working", "running"],
            ["fail-1", "error"],
            ["fail-2", "error"],
            ["done-1", "idle"],
            ["done-2", "idle"],
            ["done-3", "idle"]
          ].map(([suffix, status], index) => ({
            id: `demo-automation-fold-${suffix}`,
            title: "Docs freshness",
            status,
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            automation: {
              scheduleId: "demo-automation-fold-schedule",
              scheduleName: "Docs freshness",
              triggeredAt: FIXED_TIME - index * 36e5
            },
            createdAt: FIXED_TIME - index,
            updatedAt: FIXED_TIME - index
          }))
        ],
        approvalRequests: ["wait-1", "wait-2", "wait-3", "wait-4"].map((suffix) => ({
          id: `demo-automation-fold-approval-${suffix}`,
          threadId: `demo-automation-fold-${suffix}`,
          title: "Run outside sandbox?",
          body: "node scripts/check-docs.mjs",
          type: "shell"
        }))
      },
      {
        id: "sidebar-empty-project",
        label: "Empty unopened project in the sidebar",
        project: project("demo-empty-active"),
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off" },
        // Keep a populated conversation open: filtering a blank composer intentionally
        // opens a new thread in the selected project, which would no longer be empty.
        threads: [
          {
            id: "demo-empty-active-chat",
            title: "Open project conversation",
            status: "idle",
            messages: [
              {
                id: "demo-empty-active-message",
                role: "user",
                content: "Keep this conversation open while browsing other projects.",
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        otherProjects: [
          { project: project("demo-empty-other", "empty-project", "/demo/empty"), threads: [] }
        ]
      },
      {
        id: "sidebar-other-projects",
        label: "Sidebar listing threads of projects not opened yet",
        project: project("demo-other-projects-active", "copse-demo", "/demo/copse"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          sidebarThreadGroup: "status"
        },
        threadChanges: {
          "demo-other-projects-active-chat": { dirty: true },
          "demo-other-projects-docs-0": { dirty: false, unpushed: 2 }
        },
        // The open project has one thread; two more projects hold threads that are only
        // read in the background after startup, so their titles must still be listed.
        threads: [
          {
            id: "demo-other-projects-active-chat",
            title: "Open project thread",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            prRefs: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        otherProjects: [
          {
            project: project("demo-other-projects-docs", "docs-site", "/demo/docs-site"),
            threads: ["Rewrite the install guide", "Fix broken anchors"].map((title, index) => ({
              id: `demo-other-projects-docs-${String(index)}`,
              title,
              status: "idle",
              messages: [],
              messagesLoaded: false,
              prRefs: [],
              usage: { inputTokens: 0, outputTokens: 0 },
              createdAt: FIXED_TIME - 10 - index,
              updatedAt: FIXED_TIME - 10 - index
            }))
          },
          {
            project: project("demo-other-projects-api", "api-server", "/demo/api-server"),
            threads: [
              {
                id: "demo-other-projects-api-0",
                title: "Add pagination to the list endpoint",
                status: "idle",
                messages: [],
                messagesLoaded: false,
                prRefs: [
                  {
                    owner: "acme",
                    repo: "api-server",
                    number: 42,
                    url: "https://github.com/acme/api-server/pull/42"
                  }
                ],
                usage: { inputTokens: 0, outputTokens: 0 },
                createdAt: FIXED_TIME - 20,
                updatedAt: FIXED_TIME - 20
              }
            ]
          }
        ],
        pullRequests: [
          {
            owner: "acme",
            repo: "api-server",
            number: 42,
            url: "https://github.com/acme/api-server/pull/42",
            title: "Add pagination",
            state: "OPEN",
            body: "",
            files: [],
            checks: "success"
          }
        ]
      },
      {
        id: "sidebar-background-project-running",
        label: "Running agent in a collapsed project",
        project: project("demo-running-project", "workbench", "/demo/workbench"),
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off" },
        threads: [
          {
            id: "demo-running-thread",
            title: "Finish the migration",
            status: "running",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        otherProjects: [
          {
            project: project("demo-running-other", "docs-site", "/demo/docs-site"),
            threads: []
          }
        ]
      },
      {
        id: "sidebar-thread-sort",
        label: "Sidebar thread sort",
        project: project("demo-sidebar-sort-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // Two rows carry a trailing changes glyph, with very different title lengths,
        // so a grouped view's "· demo" owner labels can't hide a glyph that isn't
        // pinned to the row's trailing edge.
        threadChanges: {
          "demo-sidebar-sort-b": { dirty: false, unpushed: 2 },
          "demo-sidebar-sort-c": { dirty: true }
        },
        // Newest-prompted first, as the store keeps them: neither creation nor title order.
        threads: [
          {
            id: "demo-sidebar-sort-b",
            title: "Fix the flaky sandbox test",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 2,
            updatedAt: FIXED_TIME - 2
          },
          {
            id: "demo-sidebar-sort-c",
            title: "Update onboarding copy",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 1,
            updatedAt: FIXED_TIME - 1
          },
          {
            id: "demo-sidebar-sort-a",
            title: "Add a retry to uploads",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 3,
            updatedAt: FIXED_TIME - 3
          },
          {
            id: "demo-sidebar-sort-d",
            title: "Refactor auth",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 4,
            updatedAt: FIXED_TIME - 4
          },
          {
            id: "demo-sidebar-sort-e",
            title: "Run the schema migration",
            status: "running",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 5,
            updatedAt: FIXED_TIME - 5
          }
        ]
      },
      {
        id: "sidebar-cleanup-ssh",
        label: "Cleanup for SSH pull requests",
        project: {
          ...project("demo-cleanup-ssh", "Remote widgets", "/srv/widgets"),
          sshHost: "build-host"
        },
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          sshWorkspaceEnabled: true
        },
        threads: ["open", "closed"].map((state, index) => ({
          id: `ssh-cleanup-${state}`,
          title: state === "open" ? "Remote PR still open" : "Remote PR completed",
          status: state === "open" ? "running" : "idle",
          messages: [],
          messagesLoaded: false,
          prRefs: [
            {
              owner: "acme",
              repo: "widgets",
              number: index + 1,
              url: `https://github.com/acme/widgets/pull/${String(index + 1)}`
            }
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: FIXED_TIME - index,
          updatedAt: FIXED_TIME - index
        })),
        pullRequests: [1, 2].map((number) => ({
          owner: "acme",
          repo: "widgets",
          number,
          url: `https://github.com/acme/widgets/pull/${String(number)}`,
          title: "Remote change",
          state: number === 1 ? "OPEN" : "CLOSED",
          body: "",
          files: [],
          checks: "success"
        }))
      },
      {
        id: "sidebar-cleanup-after-pr",
        label: "Cleanup after merged or closed PRs",
        project: project("demo-cleanup-project"),
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off" },
        threadChanges: {
          "cleanup-dirty": { dirty: true },
          "cleanup-unpushed": { dirty: false, unpushed: 2 },
          "cleanup-clean": { dirty: false }
        },
        threads: ["dirty", "unpushed", "clean"].map((state, index) => ({
          id: `cleanup-${state}`,
          title: state === "dirty" ? "New edits after merge" : state === "unpushed" ? "Unpushed follow-up" : "Finished and clean",
          status: "idle",
          messages: [],
          messagesLoaded: false,
          prRefs: [
            {
              owner: "acme",
              repo: "widgets",
              number: index + 1,
              url: `https://github.com/acme/widgets/pull/${String(index + 1)}`
            }
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: FIXED_TIME - index,
          updatedAt: FIXED_TIME - index
        })),
        pullRequests: [1, 2, 3].map((number) => ({
          owner: "acme",
          repo: "widgets",
          number,
          url: `https://github.com/acme/widgets/pull/${String(number)}`,
          title: "Previous change",
          state: number === 2 ? "CLOSED" : "MERGED",
          body: "",
          files: [],
          checks: "success"
        }))
      },
      {
        id: "sidebar-thread-changes",
        label: "Sidebar changes glyph",
        project: project("demo-sidebar-changes-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // Two finished threads with unlanded work, one clean, one still running.
        threadChanges: {
          "demo-sidebar-changes-commits": { dirty: false, unpushed: 2 },
          "demo-sidebar-changes-dirty": { dirty: true },
          "demo-sidebar-changes-clean": { dirty: false }
        },
        threads: [
          {
            id: "demo-sidebar-changes-clean",
            title: "Update onboarding copy",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 1,
            updatedAt: FIXED_TIME - 1
          },
          {
            id: "demo-sidebar-changes-commits",
            title: "Refactor auth",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 2,
            updatedAt: FIXED_TIME - 2
          },
          {
            id: "demo-sidebar-changes-dirty",
            title: "Add a retry to uploads",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 3,
            updatedAt: FIXED_TIME - 3
          },
          {
            id: "demo-sidebar-changes-running",
            title: "Run the schema migration",
            status: "running",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 4,
            updatedAt: FIXED_TIME - 4
          }
        ]
      },
      {
        id: "activity-home",
        label: "Activity home on a new thread",
        project: project("demo-activity-home-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // The first thread is the active one and is empty, so the chat pane is the
        // Activity home. The others give it something to list: one waiting on an
        // approval, two running, one that finished while the user was elsewhere.
        // A second project, so the strip lists projects at all (a lone one adds no card).
        otherProjects: [
          { project: project("demo-activity-other-docs", "docs-site", "/demo/docs"), threads: [] }
        ],
        threads: [
          {
            id: "demo-activity-home-new",
            title: "New Thread",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          },
          {
            id: "demo-activity-home-refactor",
            title: "Refactor auth",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 1,
            updatedAt: FIXED_TIME - 1
          },
          {
            id: "demo-activity-home-audit",
            title: "Dependency audit",
            status: "running",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 2,
            updatedAt: FIXED_TIME - 2
          },
          {
            id: "demo-activity-home-flaky",
            title: "Fix the flaky sandbox test",
            status: "running",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 3,
            updatedAt: FIXED_TIME - 3
          },
          {
            id: "demo-activity-home-copy",
            title: "Update onboarding copy",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            unreadAt: FIXED_TIME - 6e4,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 4,
            updatedAt: FIXED_TIME - 4
          }
        ],
        approvalRequests: [
          {
            id: "demo-activity-home-approval",
            threadId: "demo-activity-home-refactor",
            title: "Run shell command?",
            body: "printf 'auth-check-passed\\n'",
            bodyAdvice: "Auto-run for sandbox commands is disabled in Settings",
            bodyFooter: "Allow running it once?",
            type: "shell"
          }
        ]
      },
      {
        id: "activity-home-many-projects",
        label: "Activity home listing twelve projects",
        project: project("demo-activity-many-project"),
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off" },
        // Twelve projects overflow the strip, so it scrolls with an edge fade. Only the
        // open one has thread data, so the rest read "All clear" and sort by name.
        otherProjects: [
          "Atlas",
          "Billing API",
          "Cobalt",
          "Docs site",
          "Edge workers",
          "Flight deck",
          "Gateway",
          "Harbor",
          "Ingest",
          "Jupiter",
          "Kiln"
        ].map((name) => ({
          project: {
            id: `demo-activity-many-${name.toLowerCase().replace(/\W+/g, "-")}`,
            path: `/demo/${name}`,
            name
          },
          threads: []
        })),
        threads: [
          {
            id: "demo-activity-many-new",
            title: "New Thread",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          },
          {
            id: "demo-activity-many-refactor",
            title: "Refactor auth",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 1,
            updatedAt: FIXED_TIME - 1
          }
        ],
        approvalRequests: [
          {
            id: "demo-activity-many-approval",
            threadId: "demo-activity-many-refactor",
            title: "Run shell command?",
            body: "printf 'auth-check-passed\\n'",
            type: "shell"
          }
        ]
      },
      {
        id: "activity-home-project-filter",
        label: "Activity home after a project finishes waiting",
        project: project("demo-activity-home-filter-project"),
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off" },
        // A second project, so the strip lists projects at all (a lone one adds no card).
        otherProjects: [
          { project: project("demo-activity-other-docs", "docs-site", "/demo/docs"), threads: [] }
        ],
        threads: [
          {
            id: "demo-activity-filter-new",
            title: "New Thread",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          },
          {
            id: "demo-activity-filter-refactor",
            title: "Refactor auth",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            unreadAt: FIXED_TIME - 6e4,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 1,
            updatedAt: FIXED_TIME - 1
          }
        ],
        approvalRequests: [
          {
            id: "demo-activity-filter-approval",
            threadId: "demo-activity-filter-refactor",
            title: "Run shell command?",
            body: "printf 'auth-check-passed\\n'",
            type: "shell"
          }
        ]
      },
      {
        id: "activity-home-automation-fold",
        label: "Activity home with automation runs folded",
        project: project("demo-activity-fold-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // The first thread is the empty active one. Beside a working thread and one
        // finished chat, a schedule has settled five clean runs and another three failed
        // ones: each folds into a single row instead of eight.
        threads: [
          {
            id: "demo-activity-fold-new",
            title: "New Thread",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          },
          {
            id: "demo-activity-fold-audit",
            title: "Dependency audit",
            status: "running",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 1,
            updatedAt: FIXED_TIME - 1
          },
          {
            id: "demo-activity-fold-copy",
            title: "Update onboarding copy",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            unreadAt: FIXED_TIME - 6e4,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 2,
            updatedAt: FIXED_TIME - 2
          },
          ...[
            ["docs", "Docs freshness", "idle", 5],
            ["deps", "Nightly dependency check", "error", 3]
          ].flatMap(
            ([schedule, name, status, count]) => Array.from({ length: count }, (_, index) => ({
              id: `demo-activity-fold-${schedule}-${String(index)}`,
              title: name,
              status,
              messages: [],
              messagesLoaded: false,
              unreadAt: FIXED_TIME - (index + 2) * 36e5,
              usage: { inputTokens: 0, outputTokens: 0 },
              automation: {
                scheduleId: `demo-activity-fold-${schedule}`,
                scheduleName: name,
                triggeredAt: FIXED_TIME - (index + 2) * 36e5
              },
              createdAt: FIXED_TIME - 10 - index,
              updatedAt: FIXED_TIME - 10 - index
            }))
          )
        ]
      },
      {
        id: "activity-home-question",
        label: "Activity home with a question waiting",
        project: project("demo-activity-home-question-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // The first thread is the active, empty one; the second is blocked on a question.
        threads: [
          {
            id: "demo-activity-home-question-new",
            title: "New Thread",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          },
          {
            id: "demo-activity-home-question-schema",
            title: "Schema bump",
            status: "idle",
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 1,
            updatedAt: FIXED_TIME - 1
          }
        ],
        askUserRequests: [
          {
            id: "demo-activity-home-question",
            threadId: "demo-activity-home-question-schema",
            questions: [
              {
                question: "Which migration order should the schema bump use?",
                options: ["Columns first", "Backfill first"]
              },
              { question: "Keep the old column until the next release?" }
            ]
          }
        ]
      },
      {
        id: "activity-home-read-history",
        label: "Activity home listing threads that finished before launch",
        project: project("demo-activity-history-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // The first thread is the empty active one. Everything else is idle, read, and
        // finished before this launch, so only the persisted write time puts it in
        // Recently finished. Times follow the real clock because the recency window
        // does; the last thread is older than the window and must stay out.
        threads: [
          {
            id: "demo-activity-history-new",
            title: "New Thread",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          },
          ...[
            ["refactor", "Refactor auth", "idle", 36e5 * 2],
            ["flaky", "Fix the flaky sandbox test", "error", 36e5 * 30],
            ["copy", "Update onboarding copy", "idle", 36e5 * 24 * 4],
            // Legacy-shaped: written before lastPromptAt existed, so it only has usage.
            ["legacy", "Port the settings page", "idle", 36e5 * 24 * 2],
            ["ancient", "Rename the config keys", "idle", 36e5 * 24 * 30]
          ].map(([slug, title, status, ago], index) => ({
            id: `demo-activity-history-${slug}`,
            title,
            status,
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 1200, outputTokens: 300 },
            createdAt: Date.now() - ago - 6e4,
            updatedAt: Date.now() - ago,
            ...slug === "legacy" ? {} : { lastPromptAt: Date.now() - ago - 3e4 - index }
          }))
        ]
      },
      {
        id: "activity-home-final-response",
        label: "Activity home showing the final response of finished threads",
        project: project("demo-activity-final-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // Both settled threads are metadata-only, as threads that ended before launch
        // are: the detail pane reads their last reply through threads.loadMessages.
        threads: [
          {
            id: "demo-activity-final-new",
            title: "New Thread",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          },
          ...[
            [
              "review",
              "Review open PRs",
              "idle",
              36e5,
              [
                "Reviewed the four open PRs.",
                "",
                "- **#3744** is ready to merge; CI is green.",
                "- **#3728** needs a rebase onto `main` before review.",
                "- **#3702** and **#3695** overlap; I left a comment suggesting #3695 lands first.",
                "",
                "Nothing else is waiting on you."
              ].join("\n")
            ],
            [
              "flaky",
              "Fix the flaky sandbox test",
              "error",
              36e5 * 3,
              "The retry wrapper is in place, but `pnpm test -- sandbox` still times out on the second run."
            ]
          ].map(([slug, title, status, ago, reply], index) => ({
            id: `demo-activity-final-${slug}`,
            title,
            status,
            messages: [
              {
                id: `demo-activity-final-${slug}-user`,
                role: "user",
                content: title,
                toolCalls: [],
                createdAt: Date.now() - ago - 3e4
              },
              {
                id: `demo-activity-final-${slug}-reply`,
                role: "assistant",
                content: reply,
                toolCalls: [],
                createdAt: Date.now() - ago
              }
            ],
            messagesLoaded: false,
            usage: { inputTokens: 1200, outputTokens: 300 },
            createdAt: Date.now() - ago - 6e4,
            updatedAt: Date.now() - ago,
            lastPromptAt: Date.now() - ago - 3e4 - index
          }))
        ]
      },
      {
        id: "activity-home-empty",
        label: "Activity home with nothing to list",
        project: project("demo-activity-home-empty-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        // The first-run case: one empty thread and nothing running or waiting.
        threads: [
          {
            id: "demo-activity-home-empty-new",
            title: "New Thread",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "pr-relations",
        label: "PR producing and related threads",
        project: project("demo-pr-relations", "Widgets", "/demo/widgets"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          filesPaneOpen: true,
          rightPanelMode: "prs",
          layout: {
            projectsPaneWidth: 220,
            filesPaneWidth: 660,
            filesPaneHeight: 360,
            fileTreeWidth: 220
          }
        },
        threads: [
          {
            id: "pr-producer",
            title: "Implement widget",
            status: "idle",
            messages: [],
            prProductions: [
              {
                pr: {
                  owner: "acme",
                  repo: "widgets",
                  number: 42,
                  url: "https://github.com/acme/widgets/pull/42"
                },
                source: "pr-create",
                eventId: "demo-create-42",
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          },
          {
            id: "pr-reviewer",
            title: "Review widget",
            status: "idle",
            messages: [
              {
                id: "review-refs",
                role: "user",
                content: "Review https://github.com/acme/widgets/pull/42 and https://github.com/acme/widgets/pull/43",
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            prRefs: [42, 43].map((number) => ({
              owner: "acme",
              repo: "widgets",
              number,
              url: `https://github.com/acme/widgets/pull/${String(number)}`
            })),
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          },
          {
            id: "pr-mentioned",
            title: "Release planning",
            status: "idle",
            messages: [
              {
                id: "release-ref",
                role: "user",
                content: "Include https://github.com/acme/widgets/pull/42 in the release.",
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            prRefs: [
              {
                owner: "acme",
                repo: "widgets",
                number: 42,
                url: "https://github.com/acme/widgets/pull/42"
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ],
        pullRequests: [42, 43].map((number) => ({
          owner: "acme",
          repo: "widgets",
          number,
          url: `https://github.com/acme/widgets/pull/${String(number)}`,
          title: number === 42 ? "Add widget support" : "Follow up on widget review",
          state: "OPEN",
          body: "",
          files: [],
          checks: "success"
        }))
      },
      {
        id: "side-chats",
        label: "Side chats beside the main thread",
        project: project("demo-side-chats", "Widgets", "/demo/widgets"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          layout: {
            projectsPaneWidth: 240,
            filesPaneWidth: 680,
            filesPaneHeight: 360,
            fileTreeWidth: 180
          }
        },
        threads: SIDE_CHATS_THREADS
      },
      {
        id: "side-chat-rich-markdown",
        label: "A side chat reply with a diagram, a table and code",
        project: project("demo-side-chat-rich", "Widgets", "/demo/widgets"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          layout: {
            projectsPaneWidth: 240,
            filesPaneWidth: 680,
            filesPaneHeight: 360,
            fileTreeWidth: 180
          }
        },
        threads: SIDE_CHAT_RICH_THREADS
      },
      {
        id: "side-chats-restored",
        label: "Side chats after an app restart",
        project: project("demo-side-chats-restored", "Widgets", "/demo/widgets"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          layout: {
            projectsPaneWidth: 240,
            filesPaneWidth: 680,
            filesPaneHeight: 360,
            fileTreeWidth: 180
          }
        },
        deferSideChatTranscripts: true,
        threads: SIDE_CHATS_THREADS
      },
      {
        id: "thread-context",
        changeStats: { additions: 42, deletions: 7 },
        label: "The thread Context panel",
        project: project("demo-thread-context", "Widgets", "/demo/widgets"),
        guardedYoloPhase: "active",
        contextPermissions: {
          outsideReadPaths: ["/demo/notes"],
          browserOrigins: ["https://docs.example.com:443"],
          portBindingAllowed: true
        },
        decisions: [
          {
            v: 1,
            type: "decision",
            id: "context-decision-1",
            at: FIXED_TIME - 6e4,
            kind: "shell",
            actor: "user",
            verdict: "approved",
            subject: "shell command (arguments omitted)",
            scope: "external",
            remembered: true,
            threadId: SIDE_CHATS_MAIN_ID
          },
          {
            v: 1,
            type: "decision",
            id: "context-decision-2",
            at: FIXED_TIME,
            kind: "web",
            actor: "user",
            verdict: "denied",
            subject: "https://example.net:443",
            scope: "external",
            remembered: false,
            threadId: SIDE_CHATS_MAIN_ID
          }
        ],
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          filesPaneOpen: true,
          rightPanelMode: "context",
          threadReadAccess: [SIDE_CHATS_MAIN_ID],
          threadSendAccess: [SIDE_CHATS_MAIN_ID],
          webAllowedOrigins: ["https://example.org:443"],
          toolPermissionOverrides: { "copse:run_shell": "ask" },
          layout: {
            projectsPaneWidth: 240,
            filesPaneWidth: 680,
            filesPaneHeight: 360,
            fileTreeWidth: 180
          }
        },
        threads: SIDE_CHATS_THREADS
      },
      {
        id: "thread-context-worktree",
        label: "Context identifies a dedicated worktree and its branch",
        project: project("demo-context-worktree", "Widgets", "/demo/widgets"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          filesPaneOpen: true,
          rightPanelMode: "context"
        },
        threads: SIDE_CHATS_THREADS.map(
          (thread) => thread.id === SIDE_CHATS_MAIN_ID ? {
            ...thread,
            worktree: {
              path: "/demo/widgets/.copse/worktrees/mermaid-wait",
              branch: "fix/mermaid-wait",
              baseBranch: "main",
              baseCommit: "0000000000000000000000000000000000000000",
              createdAt: FIXED_TIME,
              seededFromDirtyProject: false
            }
          } : thread
        )
      },
      {
        id: "acp-subagent-visibility",
        label: "A coding agent's own background subagents show up live",
        project: project("demo-acp-subagents", "Widgets", "/demo/widgets"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          filesPaneOpen: true,
          rightPanelMode: "context",
          layout: {
            projectsPaneWidth: 240,
            filesPaneWidth: 680,
            filesPaneHeight: 360,
            fileTreeWidth: 180
          }
        },
        threads: [
          {
            id: "acp-subagents-main",
            title: "Add blockviz to Copse",
            status: "running",
            model: "acp:claude-acp#sonnet",
            messages: [
              {
                id: "acp-subagents-user",
                role: "user",
                content: "Explore how to add the blockviz panel.",
                toolCalls: [],
                createdAt: FIXED_TIME
              },
              {
                id: "acp-subagents-assistant",
                role: "assistant",
                content: "All three exploration agents are running in the background.",
                toolCalls: [
                  // An external ACP agent's own subagent dispatch (Claude Code's
                  // `Agent` tool): no `subagent` session, just this one tool call.
                  {
                    id: "acp-agent-panel",
                    name: "Agent",
                    kind: "think",
                    title: "Panel/view registration and local content serving",
                    args: { subagent_type: "Explore", prompt: "Find the panel registry" },
                    status: "running",
                    result: null
                  },
                  {
                    id: "acp-agent-filetree",
                    name: "Agent",
                    kind: "think",
                    title: "Local file-tree reading utilities",
                    args: { subagent_type: "Explore", prompt: "Find reusable file-walking utilities" },
                    status: "running",
                    result: null
                  },
                  {
                    id: "acp-agent-rust",
                    name: "Agent",
                    kind: "think",
                    title: "Servo sidecar and Rust toolchain precedent",
                    args: {
                      subagent_type: "Investigate",
                      prompt: "Check for an existing Rust toolchain"
                    },
                    status: "done",
                    result: "No Rust toolchain found in the repo."
                  }
                ],
                createdAt: FIXED_TIME + 1e3
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME + 1e3
          }
        ]
      },
      {
        id: "side-chat-approval",
        label: "A side chat asks for approval over its parent thread",
        project: project("demo-side-chat-approval", "Widgets", "/demo/widgets"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          layout: {
            projectsPaneWidth: 240,
            filesPaneWidth: 680,
            filesPaneHeight: 360,
            fileTreeWidth: 180
          }
        },
        threads: SIDE_CHATS_THREADS,
        approvalRequests: [
          {
            id: "demo-side-chat-approval-request",
            threadId: "sc-side-1",
            title: "Run outside sandbox?",
            body: "pnpm exec wdio run wdio.e2e.conf.ts --spec tests/e2e/mermaid.e2e.ts",
            bodyFooter: "Allow running it once outside the sandbox?",
            type: "shell"
          }
        ]
      },
      {
        id: "chat-layout-styling",
        label: "Chat layout styling",
        project: project("demo-chat-layout-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off"
        },
        threads: [
          {
            id: "demo-chat-layout-thread",
            title: "Chat layout styling",
            status: "idle",
            messages: [
              {
                id: "demo-chat-layout-user",
                role: "user",
                content: "Check the pane dividers and conversation gradient.",
                toolCalls: [],
                createdAt: FIXED_TIME
              },
              {
                id: "demo-chat-layout-assistant",
                role: "assistant",
                content: "The deterministic browser fixture is ready for layout measurement.",
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      conciseThreadScenario(
        "concise-thread",
        "Concise thread view for a capable model",
        "claude-opus-5-5"
      ),
      conciseThreadScenario(
        "concise-thread-multi",
        "Concise thread view across several turns",
        "claude-opus-5-5",
        { multiTurn: true }
      ),
      conciseThreadScenario(
        "concise-thread-multi-working",
        "Concise thread view with finished turns and a live one",
        "claude-opus-5-5",
        { multiTurn: true, live: true }
      ),
      conciseThreadScenario(
        "concise-thread-full",
        "Full thread view for a model below the concise gate",
        "gpt-4o"
      ),
      {
        id: "openai-host-pr",
        label: "OpenAI host PR creation result",
        project: project("demo-openai-recovery-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          model: "remote-agent:openai#gpt-6.1-sol"
        },
        threads: [
          {
            id: "demo-openai-recovery-thread",
            title: "Create a PR from hosted changes",
            status: "idle",
            model: "remote-agent:openai#gpt-6.1-sol",
            messages: [
              {
                id: "recovery-user",
                role: "user",
                content: "Can we PR this?",
                toolCalls: [],
                createdAt: FIXED_TIME
              },
              {
                id: "recovery-assistant",
                role: "assistant",
                content: "Changes imported. Done: Created draft PR https://github.com/example/project/pull/42",
                toolCalls: [
                  {
                    id: "openai-publish-turn-push",
                    name: "gh_push",
                    args: {},
                    status: "done",
                    result: "Done: Pushed feature/mcp-apps to origin. Existing PR updated."
                  },
                  {
                    id: "openai-publish-turn-call",
                    name: "gh_pr_create",
                    args: {
                      title: "docs: MCP Apps support plan",
                      body: "Document the implementation plan.",
                      draft: true
                    },
                    status: "done",
                    result: "Done: Created draft PR https://github.com/example/project/pull/42"
                  }
                ],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "openai-cancellation-recovery",
        label: "OpenAI confirmed cancellation with interrupted recovery",
        project: project("demo-openai-recovery-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          model: "remote-agent:openai#gpt-6.1-sol"
        },
        threads: [
          {
            id: "demo-openai-recovery-thread",
            title: "Stopped hosted task",
            status: "idle",
            model: "remote-agent:openai#gpt-6.1-sol",
            messages: [
              {
                id: "recovery-user",
                role: "user",
                content: "Run the public repository tests and report the result.",
                toolCalls: [],
                createdAt: FIXED_TIME
              },
              {
                id: "recovery-assistant",
                role: "assistant",
                content: "> An error occurred: OpenAI cancellation was confirmed, but output, usage, or artifacts could not be recovered. Session sess_demo remains linked; resend the previous message to recover it before starting another task.",
                toolCalls: [],
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      ...BRIDGED_TOOL_SCENARIOS,
      conciseThreadScenario(
        "concise-thread-working",
        "Concise thread view while a capable model works",
        "claude-opus-5-5",
        { live: true }
      ),
      conciseThreadScenario(
        "concise-thread-disabled",
        "Full thread view for a capable model while Concise threads is off",
        "claude-opus-5-5",
        { enabled: false }
      ),
      {
        id: "roadmap-chat-min-width",
        label: "Roadmap side panel minimum chat width",
        project: project("demo-roadmap-chat-min-width-project"),
        settings: {
          onboardingCompleted: true,
          theme: "dark",
          uiTintStrength: "off",
          layout: { filesPaneWidth: 4e3 }
        },
        threads: [
          {
            id: "demo-roadmap-chat-min-width-thread",
            title: "Roadmap layout bounds",
            status: "idle",
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      {
        id: "chatgpt-plan-settings",
        label: "ChatGPT plan onboarding and account options",
        project: project("demo-chatgpt-plan-project"),
        settings: { onboardingCompleted: true, theme: "dark", uiTintStrength: "off" },
        chatGptPlan: {
          activeClientId: "demo-plan-account",
          accounts: [
            {
              clientId: "demo-plan-account",
              label: "you@example.com",
              connected: true,
              planEnabled: true
            }
          ]
        },
        threads: [
          {
            id: "demo-chatgpt-plan-thread",
            title: "ChatGPT plan",
            model: "chatgpt-plan:demo-plan-account#gpt-5.6-luna",
            status: "idle",
            messages: [
              {
                id: "plan-limit",
                role: "assistant",
                toolCalls: [],
                content: "> [!CAUTION]\n> ChatGPT plan usage limit reached. Review your plan or Copse\u2019s allowance.\n>\n> [Manage usage](https://chatgpt.com/settings/usage)",
                createdAt: FIXED_TIME
              }
            ],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME,
            updatedAt: FIXED_TIME
          }
        ]
      },
      // Authored states for the copse.dev feature tour (see demo-site-tour.ts).
      ...SITE_TOUR_SCENARIOS,
      // Concise thread view in each state a thread can be in (see demo-concise-states.ts).
      ...CONCISE_STATE_SCENARIOS,
      ...["read", "send"].map(
        (access) => approvalRiskScenario(`approval-thread-${access}`, {
          id: `thread-${access}`,
          type: "mcp",
          ...threadAccessApproval(access)
        })
      ),
      approvalRiskScenario("approval-web-url", {
        id: "web-url",
        title: "Allow web origin?",
        type: "web",
        ...webApprovalDetails(
          "https://example.com:443",
          "https://example.com/docs?topic=approvals",
          true
        ),
        allowRemember: true,
        rememberLabel: "Always allow https://example.com:443",
        approveLabel: "Allow request"
      }),
      approvalRiskScenario("approval-browser-url", {
        id: "browser-url",
        title: "Allow browser navigation?",
        type: "mcp",
        ...browserApprovalDetails(
          "https://example.com:443",
          "https://example.com/docs?topic=approvals",
          true
        ),
        allowRemember: true,
        rememberLabel: "Always allow https://example.com:443",
        approveLabel: "Allow navigation"
      }),
      approvalRiskScenario("approval-provider-url", {
        id: "provider-url",
        title: "Allow model provider host?",
        type: "web",
        ...providerApprovalDetails("api.example.com", "https://api.example.com/v1"),
        allowRemember: false,
        approveLabel: "Always allow host"
      })
    ];
  }
});

// src/renderer/demo/demo-api.ts
function updateDemoToolPermissions(catalog, toolIds, policy) {
  const selected = new Set(toolIds);
  return {
    groups: catalog.groups.map((group) => ({
      ...group,
      tools: group.tools.map(
        (tool) => selected.has(tool.id) ? policy ? { ...tool, policy, overridden: true } : { ...tool, policy: tool.defaultPolicy, overridden: false } : tool
      )
    }))
  };
}
function providerSlug(model) {
  if (model === void 0) return void 0;
  const colon = model.indexOf(":");
  if (colon > 0) return model.slice(0, colon);
  return firstPartyProviderOf(model) ?? void 0;
}
function stringArg(args, key) {
  if (!isRecord(args)) return void 0;
  const value = args[key];
  return typeof value === "string" ? value : void 0;
}
function proposedEdit(name, args, written) {
  const path = stringArg(args, "path");
  if (path === void 0) return void 0;
  const before = written.get(path) ?? "";
  if (name === "write_file") {
    const content = stringArg(args, "content");
    return content === void 0 ? void 0 : { path, before, after: content };
  }
  if (name === "str_replace") {
    const oldString = stringArg(args, "old_string");
    const newString = stringArg(args, "new_string");
    if (oldString === void 0 || newString === void 0) return void 0;
    return { path, before, after: before.replace(oldString, () => newString) };
  }
  return void 0;
}
function resolvedVoid() {
  return Promise.resolve();
}
function resolved(value) {
  return Promise.resolve(value);
}
function subscribe(_handler) {
  return () => void 0;
}
function unsupported() {
  return Promise.reject(new Error("This operation is not available in the browser demo."));
}
function createDemoApi(scenario2, options = {}) {
  const settings = new Map(Object.entries(scenario2.settings));
  const guardedYoloPhases = new Map(
    scenario2.guardedYoloPhase && scenario2.threads[0] ? [[scenario2.threads[0].id, scenario2.guardedYoloPhase]] : []
  );
  const guardedYoloListeners = /* @__PURE__ */ new Set();
  const demoGuardedYoloState = (threadId) => ({
    threadId,
    phase: guardedYoloPhases.get(threadId) ?? "off",
    containment: "unsandboxed",
    expiresAt: null
  });
  const updateGuardedYolo = (threadId, phase) => {
    guardedYoloPhases.set(threadId, phase);
    const state = demoGuardedYoloState(threadId);
    for (const listener of guardedYoloListeners) listener(state);
    return resolved(state);
  };
  let toolPermissionCatalog = structuredClone(scenario2.toolPermissions ?? DEMO_TOOL_PERMISSIONS);
  let mcpStatuses = scenario2.mcpServers ?? DEMO_MCP_STATUSES;
  const pendingMcpSignIns = /* @__PURE__ */ new Map();
  const storage = /* @__PURE__ */ new Map([
    [
      "projects",
      [scenario2.project, ...(scenario2.otherProjects ?? []).map((other) => other.project)]
    ],
    ["activeProjectId", scenario2.project.id]
  ]);
  let workspaceRoot = scenario2.project.path;
  let threads = structuredClone(scenario2.threads);
  const prRefsHandlers = /* @__PURE__ */ new Set();
  const showAutomationPermissions = scenario2.id === "automation-permissions";
  const demoPlugins = showAutomationPermissions ? [...DEMO_PLUGINS, DEMO_AUTOMATIONS_PLUGIN] : DEMO_PLUGINS;
  const automationSchedules = showAutomationPermissions ? [
    {
      id: "demo-weekday-review",
      projectId: scenario2.project.id,
      name: "Weekday project review",
      cron: "0 9 * * 1-5",
      prompt: "Review open work and prepare a concise project status update.",
      model: "claude-sonnet-4-6",
      enabled: false,
      permissions: [
        { kind: "copse-action", toolName: "gh_pr_approve" },
        { kind: "mcp-tool", toolName: "mcp__reports__publish_weekly" }
      ],
      createdAt: Date.parse(DEMO_TIME),
      updatedAt: Date.parse(DEMO_TIME)
    }
  ] : [];
  let navigation = {
    activeProjectId: scenario2.project.id,
    activeThreadId: threads[0]?.id ?? null
  };
  let browserSession = null;
  let currentBranch = threads[0]?.gitBranch ?? "demo/browser-renderer";
  const emptyAppleDevelopmentState = (pluginEnabled) => ({
    pluginEnabled,
    enrolled: false,
    supportedHost: false,
    toolchain: null,
    candidates: [],
    destinations: [],
    metadataRequiresExecution: false,
    selection: null,
    operations: [],
    setupMessage: pluginEnabled ? "Enroll this project to use Apple Development." : "Enable Apple Development in Settings \u2192 Plugins."
  });
  const initialAppleDevelopmentState = structuredClone(
    scenario2.appleDevelopmentState ?? emptyAppleDevelopmentState(false)
  );
  const appleDevelopmentStates = /* @__PURE__ */ new Map([
    [scenario2.project.id, initialAppleDevelopmentState]
  ]);
  const appleDevelopmentStateFor = (projectId) => appleDevelopmentStates.get(projectId) ?? emptyAppleDevelopmentState(initialAppleDevelopmentState.pluginEnabled);
  const chunkHandlers = /* @__PURE__ */ new Set();
  const showDiffHandlers = /* @__PURE__ */ new Set();
  const queuedHandlers = /* @__PURE__ */ new Set();
  const writtenFiles = /* @__PURE__ */ new Map();
  const proposedDiffs = /* @__PURE__ */ new Map();
  const expandedPaneButtons = /* @__PURE__ */ new Map();
  const emitChunk = (threadId, chunk) => {
    for (const handler of chunkHandlers) handler(threadId, chunk);
  };
  const emitProposedDiff = (threadId, chunk) => {
    if (chunk.type !== "tool_call") return;
    const edit2 = proposedEdit(chunk.toolCall.name, chunk.toolCall.args, writtenFiles);
    if (!edit2) return;
    writtenFiles.set(edit2.path, edit2.after);
    const language = detectLanguage(edit2.path);
    proposedDiffs.set(edit2.path, {
      path: edit2.path,
      before: edit2.before,
      after: edit2.after,
      language
    });
    const entries = [...writtenFiles.keys()].map((path) => ({
      path,
      language: detectLanguage(path)
    }));
    for (const handler of queuedHandlers) handler(scenario2.project.id, threadId, entries);
    if (scenario2.deferProposedDiffPreview !== true) {
      for (const handler of showDiffHandlers) {
        handler(scenario2.project.id, threadId, edit2.path, edit2.before, edit2.after, language);
      }
    }
  };
  let replay;
  const scenarioModel = scenario2.settings["model"];
  const scenarioProvider = providerSlug(
    typeof scenarioModel === "string" ? scenarioModel : void 0
  );
  const api = {
    clientActions: {
      claim: () => Promise.resolve(false),
      publish: async () => {
      },
      reply: async () => {
      },
      onInvoke: () => () => {
      }
    },
    threadPrompts: {
      onPrompt: () => () => {
      },
      reply: async () => {
      },
      revokeAccess: async () => {
      }
    },
    mobile: {
      getState: () => resolved({
        enabled: scenario2.mobileCompanion !== void 0,
        running: scenario2.mobileCompanion !== void 0,
        url: scenario2.mobileCompanion?.url ?? null,
        qrSvg: scenario2.mobileCompanion?.qrSvg ?? null,
        localUrl: null,
        localQrSvg: null,
        publicName: {
          serviceUrl: "https://api.copse.dev",
          state: "unregistered",
          hostname: null,
          certificate: null,
          dns: "unknown",
          busy: null,
          lastError: null
        },
        rootCertificatePath: null,
        address: scenario2.mobileCompanion ? new URL(scenario2.mobileCompanion.url).hostname : null,
        addresses: scenario2.mobileCompanion ? [
          {
            address: new URL(scenario2.mobileCompanion.url).hostname,
            interfaceName: "Wi-Fi",
            virtual: false
          }
        ] : [],
        devices: [],
        pairing: null,
        lastError: null
      }),
      onStateChanged: () => () => {
      },
      enable: () => resolvedVoid(),
      disable: () => resolvedVoid(),
      setDeviceAccess: () => resolvedVoid(),
      revokeDevice: () => resolvedVoid(),
      respondPairing: () => resolvedVoid(),
      revealCertificate: () => resolvedVoid(),
      registerName: () => resolvedVoid(),
      removeName: () => resolvedVoid(),
      recheckNameDns: () => resolvedVoid(),
      onChat: () => () => {
      },
      reply: async () => {
      }
    },
    windowState: {
      getNavigation: () => resolved(structuredClone(navigation)),
      setNavigation: (next) => {
        navigation = structuredClone(next);
        return resolvedVoid();
      },
      getBrowserSession: () => resolved(browserSession ? structuredClone(browserSession) : null),
      setBrowserSession: (next) => {
        browserSession = structuredClone(next);
        return resolvedVoid();
      }
    },
    workspace: {
      open: () => resolved(workspaceRoot),
      get: () => resolved(workspaceRoot),
      set: (root) => {
        workspaceRoot = root;
        return resolved(root);
      },
      isTrusted: () => resolved(true),
      setTrusted: emptyArray,
      unsandboxedProjectHooks: emptyArray,
      // The demo bundle is browser-targeted (no `node:path`), and demo paths are
      // display-only POSIX strings, so join by hand rather than importing path.
      createNewProject: (name, parentDir) => resolved(`${parentDir.replace(/\/+$/, "")}/${name}`),
      pickParentDirectory: () => resolved(null),
      getHomeDirectory: () => resolved(""),
      onOpened: subscribe
    },
    browser: {
      workspaceFileUrl: (_projectId, _threadId, path) => resolved(`http://localhost:4173/${encodeURI(path)}`),
      onOpenTab: subscribe,
      sharePageText: unsupported,
      shareScreenshot: unsupported,
      captureScreenshot: unsupported,
      scrollPosition: unsupported,
      exportPdf: unsupported,
      exportPage: unsupported,
      exportArtefact: unsupported,
      onShareText: subscribe,
      onShareImage: subscribe,
      onPluginTabRequest: subscribe
    },
    security: {
      getGuardedYolo: (threadId) => resolved(demoGuardedYoloState(threadId)),
      getContextPermissions: () => resolved(
        scenario2.contextPermissions ?? {
          outsideReadPaths: [],
          browserOrigins: [],
          portBindingAllowed: false
        }
      ),
      enableGuardedYolo: (threadId) => updateGuardedYolo(threadId, "armed"),
      disableGuardedYolo: (threadId) => updateGuardedYolo(threadId, "off"),
      onGuardedYoloChanged: (listener) => {
        guardedYoloListeners.add(listener);
        return () => {
          guardedYoloListeners.delete(listener);
        };
      }
    },
    container: {
      runThread: (request) => resolved({
        threadId: request.threadId,
        runtimeId: "run-demo",
        phase: "running",
        startedAt: Date.now(),
        finishedAt: null,
        prompt: request.prompt,
        model: request.model,
        egressAllowlist: ["api.anthropic.com:443"],
        credential: request.useAgentLogin ? "login" : "key",
        settings: {
          budgets: { ...request.budgets },
          installDependencies: request.installDependencies === true
        },
        log: ["[thread-container] starting copse-run-demo from copse-worker:local"],
        warnings: [],
        checkout: { root: "/repo", mode: "shared", branch: "main" },
        record: null,
        error: null,
        continuedFrom: request.continueFrom ?? null
      }),
      stopRun: () => resolved(null),
      adoptRun: () => resolved({
        applied: [
          "a1b2c3d fix(lint): remove unused imports across src/main",
          "b2c3d4e fix(lint): prefer nullish coalescing in providers",
          "c3d4e5f chore: rerun formatter"
        ],
        alreadyApplied: 0
      }),
      getRun: (threadId) => resolved(
        scenario2.containerRun && scenario2.containerRun.threadId === threadId ? scenario2.containerRun : null
      ),
      modelAvailability: (models) => resolved(
        Object.fromEntries(
          models.map((model) => [model, { reason: "not available in the demo" }])
        )
      ),
      onRunChanged: subscribe
    },
    fs: {
      readFile: (_projectId, _threadId, path) => resolved(writtenFiles.get(path) ?? ""),
      readImage: () => Promise.reject(new Error("Workspace images are unavailable in this demo")),
      writeFile: resolvedVoid,
      readdir: () => resolved(["src", "tests", "package.json"]),
      listDir: () => resolved([
        { name: "src", isDir: true },
        { name: "tests", isDir: true },
        { name: "package.json", isDir: false }
      ]),
      watch: resolvedVoid,
      unwatch: resolvedVoid,
      onChanged: subscribe
    },
    agent: {
      run: (_projectId, threadId, payload) => {
        const { userContent } = parseAgentRunPayload(payload);
        const prompt = workingBriefFromUserContent(userContent) ?? "image prompt";
        const trace = scenario2.trace;
        if (trace && prompt.trim() === demoScenarioPrompt(scenario2).trim()) {
          replay?.abort();
          const controller = new AbortController();
          replay = controller;
          const emit = (chunk) => {
            emitChunk(threadId, chunk);
            emitProposedDiff(threadId, chunk);
          };
          void playTrace(trace, emit, {
            ...options.trace,
            signal: controller.signal
          });
          return resolvedVoid();
        }
        emitChunk(threadId, {
          type: "text",
          text: "The renderer receives each response chunk, appends it to the conversation, and marks the turn complete when streaming ends."
        });
        emitChunk(threadId, {
          type: "usage",
          model: DEMO_MODEL,
          inputTokens: Math.max(1, Math.ceil(prompt.length / CHARS_PER_TOKEN)),
          outputTokens: 18,
          estimated: true
        });
        emitChunk(threadId, { type: "done", stopReason: "end_turn" });
        return resolvedVoid();
      },
      runMachine: () => resolved("completed"),
      describeImages: () => resolved({ text: "Demo image description." }),
      // The first message on a blank thread commits a checkout decision before
      // it dispatches, so these cannot stay `unsupported` — rejecting here puts
      // a retry error where the demo's answer should be. Nothing is checked out
      // in a browser; the demo always stays on the shared branch.
      prepareCheckout: (_projectId, _threadId, _prompt, choice) => resolved({ checkoutMode: "shared", choice, branch: currentBranch }),
      renameCheckoutBranch: () => resolved(null),
      previewCheckout: () => resolved({ checkoutMode: "shared" }),
      resetDefaultBranchCache: () => resolvedVoid(),
      estimateContext: (_projectId, _threadId, payload) => resolved({
        segments: [
          {
            key: "message",
            label: "Your message",
            tokens: Math.ceil(payload.length / CHARS_PER_TOKEN)
          }
        ],
        totalTokens: Math.ceil(payload.length / CHARS_PER_TOKEN),
        contextWindow: 2e5
      }),
      abort: () => {
        replay?.abort();
        return resolvedVoid();
      },
      // A fixture thread seeded as running IS the live run in the demo world.
      // Answering [] here would have resumePendingQueues flip it to idle as a
      // crash leftover the moment the project loads (#1406's reconciliation).
      runningThreadIds: () => resolved(threads.filter((t) => t.status === "running").map((t) => t.id)),
      retryReview: resolvedVoid,
      clearHistory: resolvedVoid,
      refreshModelContext: resolvedVoid,
      suggestTitle: () => resolved(null),
      suggestTerminalTitle: () => resolved(null),
      suggestCommandSummary: () => resolved(null),
      suggestToolTurnSummary: () => resolved(null),
      suggestFollowUps: () => resolved(structuredClone([...scenario2.followUps ?? []])),
      suggestPrBody: () => resolved(scenario2.prBody ?? null),
      suggestNextStep: () => resolved(null),
      replayPendingDecisions: () => resolvedVoid(),
      attachTranscripts: () => resolvedVoid(),
      onTranscriptSnapshot: () => () => {
      },
      onChunk: (handler) => {
        chunkHandlers.add(handler);
        return () => {
          chunkHandlers.delete(handler);
        };
      },
      onApprovalRequest: (handler) => {
        for (const approvalRequest of scenario2.approvalRequests ?? []) {
          const request = structuredClone(approvalRequest);
          setTimeout(() => {
            handler(request);
          }, 0);
        }
        return () => void 0;
      },
      onApprovalCancelled: subscribe,
      onAskUserRequest: (handler) => {
        for (const askUserRequest of scenario2.askUserRequests ?? []) {
          const request = {
            id: askUserRequest.id,
            ...askUserRequest.threadId === void 0 ? {} : { threadId: askUserRequest.threadId },
            ...askUserRequest.presentation === void 0 ? {} : { presentation: askUserRequest.presentation },
            questions: askUserRequest.questions.map((question) => ({
              question: question.question,
              ...question.options === void 0 ? {} : { options: [...question.options] }
            }))
          };
          setTimeout(() => {
            handler(request);
          }, 0);
        }
        return () => void 0;
      },
      onAskUserCancelled: subscribe,
      onShellOutput: subscribe,
      onRefreshContextEstimate: subscribe,
      onHookQueueMessage: subscribe
    },
    diff: {
      approve: resolvedVoid,
      reject: resolvedVoid,
      approveAll: resolvedVoid,
      rejectAll: resolvedVoid,
      content: (_projectId, _threadId, path) => resolved(proposedDiffs.get(path) ?? null),
      // Same list `onQueued` pushes — panes hydrate from this on mount.
      queue: () => resolved(
        [...writtenFiles.keys()].map((path) => ({ path, language: detectLanguage(path) }))
      ),
      onShowDiff: (handler) => {
        showDiffHandlers.add(handler);
        return () => {
          showDiffHandlers.delete(handler);
        };
      },
      onQueued: (handler) => {
        queuedHandlers.add(handler);
        return () => {
          queuedHandlers.delete(handler);
        };
      },
      onConflict: subscribe
    },
    approval: { respond: resolvedVoid },
    review: { run: resolvedVoid, dismissFinding: resolvedVoid, restoreFinding: resolvedVoid },
    ask: { respond: resolvedVoid },
    alerts: { threadFinished: resolvedVoid, onOpenThread: subscribe },
    deepLinks: { ready: resolvedVoid, onOpenThread: subscribe },
    sshPrompt: {
      respond: resolvedVoid,
      onRequest: subscribe
    },
    updatePrompt: {
      respond: resolvedVoid,
      onRequest: (handler) => {
        for (const { changelog, buttons, ...rest } of scenario2.updatePromptRequests ?? []) {
          const request = {
            ...structuredClone(rest),
            buttons: [...buttons],
            ...changelog ? { changelog: changelog.map((entry) => ({ ...entry })) } : {}
          };
          setTimeout(() => {
            handler(request);
          }, 0);
        }
        return () => void 0;
      },
      onDevNotice: subscribe
    },
    closeConfirm: {
      respond: resolvedVoid,
      onRequest: subscribe
    },
    sshWorkspace: {
      listHosts: emptyArray,
      listConfigAliases: emptyArray,
      getStates: emptyArray,
      listCredentialHostIds: emptyArray,
      forgetCredentials: resolvedVoid,
      connect: emptyArray,
      disconnect: emptyArray,
      reconnect: emptyArray,
      listDirectory: emptyArray,
      registerRoot: () => resolved("/demo"),
      onConnectionChanged: subscribe
    },
    mcp: {
      list: () => resolved(structuredClone([...mcpStatuses])),
      reload: emptyArray,
      setEnabled: emptyArray,
      listCurated: emptyArray,
      listDeclared: emptyArray,
      setCuratedEnabled: emptyArray,
      // The demo has no browser to finish a sign-in, so it waits like the real
      // flow does until the visitor cancels.
      signIn: (name) => new Promise((_resolve, reject) => {
        pendingMcpSignIns.set(name, () => {
          reject(new Error("Sign-in cancelled."));
        });
      }),
      cancelSignIn: (name) => {
        pendingMcpSignIns.get(name)?.();
        pendingMcpSignIns.delete(name);
        return resolvedVoid();
      },
      signOut: (name) => {
        mcpStatuses = mcpStatuses.map(
          (status) => status.name === name ? {
            ...status,
            state: "error",
            error: "Sign-in required",
            auth: "required",
            toolCount: 0,
            tools: []
          } : status
        );
        return resolved(structuredClone([...mcpStatuses]));
      },
      onStatusChanged: subscribe
    },
    toolPermissions: {
      list: () => resolved(structuredClone(toolPermissionCatalog)),
      set: (update) => {
        toolPermissionCatalog = updateDemoToolPermissions(
          toolPermissionCatalog,
          update.toolIds,
          update.policy
        );
        return resolved(structuredClone(toolPermissionCatalog));
      },
      reset: (reset) => {
        toolPermissionCatalog = updateDemoToolPermissions(toolPermissionCatalog, reset.toolIds);
        return resolved(structuredClone(toolPermissionCatalog));
      }
    },
    canvas: {
      onArtefact: subscribe,
      onShowArtefact: subscribe,
      // The demo has no canvas store behind it: nothing was ever saved, so
      // nothing can be listed or reopened.
      listArtefacts: () => resolved([]),
      readArtefact: () => resolved(null),
      reopenArtefact: () => resolved(false)
    },
    storage: {
      containerCleanup: () => resolved({ removed: 0, bytes: 0, skipped: 0 }),
      maintenance: () => resolved({
        containers: emptyContainerStorage(),
        retention: { enabled: true, days: 30 },
        areas: [
          { area: "runs", bytes: 0, entries: 0, busy: false },
          { area: "builds", bytes: 0, entries: 0, busy: false }
        ]
      }),
      cleanup: () => resolved({ removed: 0, bytes: 0, skipped: 0 }),
      retention: () => resolvedVoid(),
      get: (key) => resolved(storage.get(key)),
      set: (key, value) => {
        storage.set(key, value);
        return resolvedVoid();
      }
    },
    // The browser demo has no chat store on disk, so a dropped archive is held
    // by name only: the chip shows what the visitor attached, and the agent's
    // reply is the demo's usual stub rather than a reading of its contents.
    archive: {
      attach: (_projectId, threadId, archive) => resolved({
        path: archive.path ?? `/demo/${scenario2.project.id}/${threadId}/blobs/${archive.name}`,
        name: archive.name,
        sizeBytes: archive.bytes?.byteLength ?? 0
      })
    },
    plans: { get: () => resolved(null), revision: () => resolved(null), change: unsupported },
    threads: {
      archiveState: () => resolved({ archived: threads.filter((thread) => thread.archivedAt != null), review: [] }),
      archiveDecision: (_projectId, threadId, decision) => {
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (!thread) return resolved(false);
        if (decision === "archive") thread.archivedAt = Date.now();
        if (decision === "restore") delete thread.archivedAt;
        thread.updatedAt = Date.now();
        return resolved(true);
      },
      onAutoArchived: () => () => {
      },
      storageSize: () => resolved({ bytes: 24576, truncated: false }),
      archive: (_projectId, threadId) => {
        const archivedAt = Date.now();
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (thread) thread.archivedAt = archivedAt;
        return resolved({ status: "archived", archivedAt, worktree: thread?.worktree });
      },
      loadProject: (projectId) => resolved(
        projectId === scenario2.project.id ? structuredClone(threads).map(
          (thread) => scenario2.deferSideChatTranscripts === true && thread.sideChat !== void 0 ? { ...thread, messages: [], messagesLoaded: false } : thread
        ) : structuredClone(
          scenario2.otherProjects?.find((other) => other.project.id === projectId)?.threads ?? []
        )
      ),
      // The demo always hands back whole threads, so nothing ever asks to
      // hydrate one; answering from the in-memory list keeps that true. The
      // exceptions are scenarios built around the hydration window itself,
      // which hold the read open (or fail it) so the mid-switch state stays
      // on screen.
      loadMessages: (_projectId, threadId) => scenario2.holdThreadHydration === true ? new Promise(() => void 0) : scenario2.failThreadHydration === true ? Promise.reject(new Error("demo: transcript read failed")) : resolved(structuredClone(threads.find((t) => t.id === threadId)?.messages ?? [])),
      // Demo threads link no PRs, so a backfill answers each one with an empty ref set —
      // the settled "no PR" the sidebar waits for before it draws a row's changes glyph.
      backfillPrRefs: (projectId, threadIds) => {
        for (const handler of prRefsHandlers) {
          handler(
            projectId,
            threadIds.map((threadId) => ({ threadId, prRefs: [] }))
          );
        }
        return resolvedVoid();
      },
      onPrRefs: (handler) => {
        prRefsHandlers.add(handler);
        return () => {
          prRefsHandlers.delete(handler);
        };
      },
      // No demo scenario opens a real PR, so nothing ever announces one.
      onPrCreated: () => () => void 0,
      create: (_projectId, thread) => {
        threads = [thread, ...threads.filter((candidate) => candidate.id !== thread.id)];
        return resolvedVoid();
      },
      appendMessage: (_projectId, threadId, message) => {
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (thread && !thread.messages.some((candidate) => candidate.id === message.id)) {
          thread.messages.push(message);
        }
        return resolvedVoid();
      },
      annotateMessage: (_projectId, threadId, messageId, annotation) => {
        const message = threads.find((candidate) => candidate.id === threadId)?.messages.find((candidate) => candidate.id === messageId);
        if (message) Object.assign(message, annotation);
        return resolvedVoid();
      },
      updateMeta: (_projectId, threadId, patch) => {
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (thread) Object.assign(thread, patch);
        return resolvedVoid();
      },
      recordModelSelection: (_projectId, threadId, by, from, to) => {
        const selection = {
          id: `demo-model-selection-${String(Date.now())}`,
          recordedAt: Date.now(),
          by,
          ...from !== void 0 ? { from } : {},
          to
        };
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (thread) {
          thread.model = to;
          thread.modelSelections = [...thread.modelSelections ?? [], selection];
        }
        return resolved(selection);
      },
      delete: (_projectId, threadId) => {
        threads = threads.filter((candidate) => candidate.id !== threadId);
        return resolvedVoid();
      },
      // The browser demo has no chat store on disk to zip up.
      exportArchive: unsupported,
      // The demo has no provider history sidecar to inherit; the forked thread's
      // transcript copy (which the renderer owns) is the whole demo story.
      fork: () => resolved({ source: "empty", messageCount: 0 }),
      backlinks: (_projectId, kind, target) => resolved(backlinksFor(threads, kind, target)),
      pendingApprovals: () => resolved([]),
      historySnapshot: unsupported,
      editHistory: unsupported,
      undoHistoryEdit: unsupported,
      catalog: () => resolved(
        threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          digest: thread.messages.at(-1)?.content ?? "",
          path: thread.id,
          spinePath: `/demo/${scenario2.project.id}/${thread.id}/events.jsonl`,
          prRefs: []
        }))
      ),
      listOrphans: emptyArray
    },
    openRouter: { models: emptyArray },
    models: {
      invalidations: () => resolved({
        evaluated: true,
        invalidations: [],
        selections: [],
        verifiedChoices: []
      }),
      recoverSetting: () => resolved(false),
      bestValueDefault: () => resolved("lmstudio:qwen/qwen3.6-35b-a3b"),
      resolveDynamic: (value) => resolved(value.startsWith("auto:") ? "lmstudio:qwen/qwen3.6-35b-a3b" : value)
    },
    intellect: {
      liveModels: () => resolved({ ok: false, models: [], error: "Unavailable in demo" })
    },
    // No network in the demo, so nothing resolves and the value map shows no
    // card links — the same state as a probe that found nothing.
    modelCards: {
      resolve: (modelIds) => resolved(Object.fromEntries(modelIds.map((id) => [id, null])))
    },
    lmStudio: {
      test: () => resolved({ ok: false, error: "Unavailable in demo" }),
      models: emptyArray,
      modelInfo: emptyArray,
      detect: () => resolved({
        serverRunning: false,
        serverUrl: "http://127.0.0.1:1234/v1",
        installDetected: false,
        models: [],
        modelContexts: {},
        preferredPresent: [],
        preferredMissing: []
      }),
      download: () => resolved({ ok: false, error: "Unavailable in demo" }),
      downloadStatus: (jobId) => resolved({
        ok: false,
        jobId,
        error: "Unavailable in demo"
      })
    },
    remoteAgent: {
      downloadArtifact: unsupported,
      artifactImageDataUrl: unsupported,
      models: emptyArray,
      refreshImportedThread: () => resolved(null),
      discoverExternal: (_projectId) => resolved({
        imported: [],
        scanned: 0,
        skippedLinked: 0,
        skippedWrongRepo: 0,
        skippedInactive: 0
      })
    },
    acp: {
      browseRegistry: () => resolved({ entries: [], fetchedAt: Date.now(), skipped: 0 }),
      detectAgents: emptyArray,
      probeAgent: unsupported,
      authStatus: emptyArray,
      autoSetup: () => resolved({
        installed: [],
        upgraded: [],
        registered: [],
        modelsDetected: [],
        failed: []
      })
    },
    processManager: {
      snapshot: () => resolved({ sampledAt: Date.now(), processes: [] }),
      stopBackground: () => resolved(false)
    },
    menu: {
      onProcessManager: subscribe,
      onSettings: subscribe,
      onNewThread: subscribe,
      onToggleSidebar: subscribe,
      onTogglePanel: subscribe,
      onShowExplorer: subscribe,
      onShowTerminal: subscribe,
      onShowChanges: subscribe,
      onShowBrowser: subscribe,
      onFocusBrowserUrlBar: subscribe,
      onKeyboardShortcuts: subscribe,
      onUiScaleZoomIn: subscribe,
      onUiScaleZoomOut: subscribe,
      onUiScaleReset: subscribe
    },
    machines: {
      state: () => resolved({
        featureEnabled: false,
        machines: [],
        addresses: [],
        sharing: {
          enabled: false,
          address: "127.0.0.1",
          port: 4319,
          profileIds: [],
          listening: false,
          error: null
        },
        shareableModels: [],
        clients: [],
        secureStorage: false
      }),
      pair: unsupported,
      remove: unsupported,
      share: unsupported,
      invitation: unsupported,
      revoke: unsupported
    },
    classifiers: {
      list: emptyArray,
      save: unsupported,
      remove: unsupported,
      test: unsupported,
      screening: () => resolved(null),
      setScreening: unsupported,
      background: () => resolved(null),
      setBackground: unsupported
    },
    localClassifiers: {
      status: () => resolved({ servers: [], hosted: [] }),
      install: unsupported,
      start: unsupported,
      stop: unsupported,
      uninstall: unsupported,
      connect: unsupported
    },
    environmentSetup: {
      status: () => resolved({ offer: false, promptCount: 0 }),
      review: unsupported,
      apply: unsupported,
      undo: unsupported,
      dismiss: resolvedVoid
    },
    chatGptPlan: {
      status: () => resolved(scenario2.chatGptPlan ?? { accounts: [], activeClientId: null }),
      signIn: unsupported,
      refreshAccount: () => scenario2.chatGptPlan ? resolved(scenario2.chatGptPlan) : unsupported(),
      cancelSignIn: resolvedVoid,
      selectAccount: unsupported,
      signOut: unsupported,
      models: () => resolved({
        clientId: scenario2.chatGptPlan?.activeClientId ?? null,
        models: scenario2.chatGptPlan?.activeClientId ? [{ slug: "gpt-5.6-luna", displayName: "GPT-5.6-Luna" }] : []
      })
    },
    settings: {
      getSnapshot: () => {
        const values = Object.fromEntries(settings);
        const snapshot = values;
        return resolved(snapshot);
      },
      update: (changes) => {
        const { roleAssignments, ...ordinary } = changes;
        const next = new Map(settings);
        for (const [key, value] of Object.entries(ordinary)) next.set(key, value);
        if (roleAssignments)
          next.set("roleModels", {
            ...stringRecordOrEmpty(settings.get("roleModels")),
            ...roleAssignments
          });
        settings.clear();
        for (const [key, value] of next) settings.set(key, value);
        return resolvedVoid();
      },
      get: (key) => resolved(settings.get(key)),
      set: (key, value) => {
        settings.set(key, value);
        return resolvedVoid();
      },
      setSecurity: resolvedVoid,
      // The demo stands in for a configured install: the provider behind the
      // scenario's model reads as available, so the footer names the model that
      // answered instead of labelling it "(no key)".
      getKey: (provider) => resolved(provider === scenarioProvider),
      getKeyEncrypted: () => resolved(null),
      setKey: () => resolved({ ok: true }),
      availableProviders: () => resolved({ mock: true, ...scenarioProvider ? { [scenarioProvider]: true } : {} }),
      validateKey: () => resolved({ ok: false, error: "Unavailable in demo" }),
      scanEnvKeys: emptyArray,
      importEnvKeys: (_providers) => resolved({ imported: [], skipped: [] }),
      extraProviders: emptyArray,
      // The demo's scenario models are all in the static cloud catalog, so the
      // footer prices them without any fetched rates.
      modelPricing: () => resolved({}),
      saveExtraProvider: emptyArray,
      deleteExtraProvider: emptyArray,
      fetchProviderModels: () => resolved({ ok: false, models: [], error: "Unavailable in demo" }),
      refreshHuggingFaceModels: () => resolved({ ok: false, count: 0, error: "Unavailable in demo" })
    },
    appIcon: { apply: resolvedVoid },
    about: {
      getInfo: () => resolved({ version: "demo", report: null }),
      openLicenseFile: resolvedVoid
    },
    usage: {
      getSummary: () => {
        const emptyPeriod = {
          totalCostUsd: 0,
          cloudModels: [],
          localModels: [],
          classifiers: [],
          totalInputTokens: 0,
          totalOutputTokens: 0,
          hasUnpricedCloudUsage: false
        };
        return resolved({
          day: emptyPeriod,
          month: emptyPeriod,
          period90d: emptyPeriod,
          allTime: emptyPeriod,
          trackingStartedAt: null,
          ledgerEventCount: 0
        });
      },
      getThreadClassifierUse: () => resolved({ calls: 0, rows: [] }),
      getPlanUsage: () => resolved({ providers: [], checkedAt: DEMO_TIME }),
      getPlanWorthIt: () => resolved({
        worthIt: {
          verdict: "insufficient_history",
          reason: "Need a couple of completed weekly windows \u2014 keep Copse signed into Claude and reopen Usage after resets.",
          apiEquivalentBurnPerWeek: null,
          planFeePerWeek: null,
          monthlyFeeUsd: null,
          feeHint: null,
          completedWeeklyCount: 0,
          inferenceFrontierNote: null
        },
        windowExhaustion: [],
        historySampleCount: 0,
        completedWeeklyCount: 0
      }),
      setClaudePlanMonthlyFee: () => resolved({
        worthIt: {
          verdict: "insufficient_history",
          reason: "Need a couple of completed weekly windows \u2014 keep Copse signed into Claude and reopen Usage after resets.",
          apiEquivalentBurnPerWeek: null,
          planFeePerWeek: null,
          monthlyFeeUsd: null,
          feeHint: null,
          completedWeeklyCount: 0,
          inferenceFrontierNote: null
        },
        windowExhaustion: [],
        historySampleCount: 0,
        completedWeeklyCount: 0
      })
    },
    index: {
      query: (pattern) => resolved(
        ["src/renderer/main.ts", "src/renderer/demo/demo-api.ts", "package.json"].filter(
          (path) => path.toLowerCase().includes(pattern.toLowerCase())
        )
      ),
      resolveFileReferences: emptyArray,
      status: () => resolved({
        fileIndex: { phase: "ready" },
        semantic: { phase: "unavailable" }
      }),
      onStatusChanged: subscribe
    },
    ports: {
      // The browser demo has no host to scan, so the pane shows its empty state.
      list: () => resolved({ rows: [], tool: "demo" }),
      kill: () => resolved({ killed: false, reason: "Ports are not available in the demo." })
    },
    vnc: {
      open: unsupported,
      list: emptyArray,
      discover: () => resolved([...scenario2.vncDiscoveredPorts ?? []]),
      discoverNearby: emptyArray,
      resolveSshHosts: emptyArray,
      getUsername: () => resolved(scenario2.vncSavedLogin?.username ?? null),
      getPassword: () => resolved(null),
      hasPassword: () => resolved(scenario2.vncSavedLogin !== void 0),
      canStoreCredentials: () => resolved(scenario2.vncSavedLogin !== void 0),
      rememberUsername: () => resolved(false),
      rememberPassword: () => resolved(false),
      forgetPassword: resolvedVoid,
      forgetCredentials: resolvedVoid,
      start: () => {
      },
      send: () => {
      },
      close: resolvedVoid,
      onData: subscribe,
      onStatus: subscribe
    },
    simulatorDesktop: {
      list: emptyArray,
      open: unsupported,
      start: resolvedVoid,
      input: resolvedVoid,
      close: resolvedVoid,
      onFrame: subscribe,
      onStatus: subscribe,
      onShow: subscribe
    },
    memories: {
      list: emptyArray,
      create: unsupported,
      update: () => resolved(null),
      delete: () => resolved(false)
    },
    roadmap: {
      list: emptyArray,
      create: unsupported,
      update: () => resolved(null),
      setStatus: () => resolved(null),
      setCategory: () => resolved(null),
      delete: () => resolved(false),
      export: unsupported,
      issueUrl: () => resolved(null),
      openIssues: () => resolved({ slug: "copse-dev/agent-pane", issues: [], hasMore: false }),
      importIssues: emptyArray,
      matchOpenIssues: emptyArray,
      checkFit: unsupported,
      attachmentData: () => resolved(null),
      prepareReview: unsupported,
      lastReviewAt: () => resolved({
        lastReviewAt: null,
        lastAcknowledgedBulkRun: null,
        pendingBulkRun: null
      }),
      reviewItem: unsupported,
      reviewItemDeep: unsupported,
      completeReview: () => resolved(false),
      abortReview: () => resolved(false),
      onChanged: subscribe,
      setThread: () => resolved(null),
      findByThread: () => resolved(null)
    },
    supervisor: {
      list: () => resolved({ tasks: [] }),
      cancel: () => resolved({ task: null }),
      get: () => resolved({ task: null }),
      resume: () => resolved({ task: null }),
      onChanged: subscribe
    },
    // The browser demo has no repository behind it, so it owns no checkouts to
    // list and nothing that could be measured or deleted.
    worktrees: {
      list: emptyArray,
      size: (_projectId, path) => resolved({ path, bytes: 0, fileCount: 0, truncated: false }),
      cleanupPackages: (_projectId, path) => resolved({
        status: "ready",
        path,
        directories: [],
        bytes: 0,
        truncated: false
      }),
      openTerminal: resolvedVoid,
      remove: unsupported
    },
    agents: { list: () => resolved({ agents: [], skipped: [], shadowed: [] }) },
    skills: {
      list: emptyArray,
      sources: () => resolved({ skills: [], diagnostics: [], extraRoots: [], reload: "manual" }),
      setRoots: (extraRoots) => resolved({
        skills: [],
        diagnostics: [],
        extraRoots,
        reload: "manual"
      })
    },
    cursorPlugins: { list: emptyArray },
    bundledSkillPlugins: { list: emptyArray },
    hooks: {
      list: () => resolved({ hooks: [], warnings: [] }),
      test: unsupported,
      runDetail: () => resolved({ found: false })
    },
    plugins: {
      list: () => resolved({
        plugins: demoPlugins.map(
          (plugin) => plugin.id === "copse.apple-development" ? { ...plugin, enabled: initialAppleDevelopmentState.pluginEnabled } : plugin
        )
      }),
      setEnabled: () => resolved({ plugins: [] }),
      setSetting: () => resolved({ plugins: [] }),
      addSource: () => resolved({ plugins: [] }),
      listInstalls: emptyArray,
      prepareInstall: () => scenario2.pluginInstallReview ? resolved(scenario2.pluginInstallReview) : unsupported(),
      cancelInstall: resolvedVoid,
      commitInstall: unsupported,
      uninstall: unsupported,
      rollback: unsupported
    },
    decisions: {
      list: () => resolved(scenario2.decisions ?? []),
      listThread: (_projectId, threadId) => resolved((scenario2.decisions ?? []).filter((decision) => decision.threadId === threadId)),
      export: () => resolved({ path: "", count: 0 })
    },
    automations: {
      list: () => resolved(structuredClone(automationSchedules)),
      permissionOptions: () => resolved(showAutomationPermissions ? structuredClone(DEMO_AUTOMATION_PERMISSIONS) : []),
      upsert: unsupported,
      remove: unsupported,
      runNow: unsupported,
      cleanupRuns: unsupported,
      listBranchCi: emptyArray,
      upsertBranchCi: unsupported,
      removeBranchCi: unsupported,
      testBranchCi: unsupported,
      eventHistory: emptyArray,
      reportStartFailure: () => resolved(false),
      schedulerHealth: () => resolved({ state: "ok", since: null, message: null }),
      onSchedulerHealth: subscribe,
      canStart: () => resolved({ allowed: true }),
      onTriggered: subscribe
    },
    appRun: {
      detect: () => resolved(false),
      discover: () => resolved({ apps: [], devices: [], issues: [], preferred: null }),
      cancelDiscovery: () => resolved(void 0),
      devices: () => resolved([]),
      operations: () => resolved([]),
      execute: () => Promise.reject(new Error("App running requires the desktop app.")),
      cancel: () => resolved(void 0),
      stop: () => resolved(void 0),
      setupOptions: () => resolved({ runtimes: [], deviceTypes: [] }),
      setup: () => resolved(null)
    },
    appleDevelopment: {
      state: (projectId) => resolved(structuredClone(appleDevelopmentStateFor(projectId))),
      detectProject: (projectId) => {
        const state = appleDevelopmentStateFor(projectId);
        return resolved({
          detected: state.candidates.length > 0,
          enrolled: state.enrolled,
          supportedHost: state.supportedHost
        });
      },
      // The demo never interrupts a scenario with the open-time suggestion.
      suggestion: (projectId) => resolved({
        offer: "none",
        pluginEnabled: appleDevelopmentStateFor(projectId).pluginEnabled
      }),
      answerSuggestion: () => resolved(void 0),
      setEnrolled: (projectId, _threadId, enrolled) => {
        const current = appleDevelopmentStateFor(projectId);
        const state = {
          ...current,
          enrolled,
          setupMessage: enrolled ? projectId === scenario2.project.id ? null : "No Xcode workspace or project was found within the project directory." : "Enroll this project to use Apple Development."
        };
        appleDevelopmentStates.set(projectId, state);
        return resolved(structuredClone(state));
      },
      discover: unsupported,
      destinations: (projectId) => resolved(structuredClone(appleDevelopmentStateFor(projectId).destinations)),
      configure: unsupported,
      execute: unsupported,
      operation: unsupported,
      stopApp: unsupported
    },
    instructions: { list: emptyArray, read: () => resolved("") },
    cursorRules: { list: emptyArray },
    terminal: {
      create: () => resolved({
        sessionId: "demo-terminal",
        checkoutMode: "shared"
      }),
      write: resolvedVoid,
      resize: resolvedVoid,
      destroy: resolvedVoid,
      setMeta: resolvedVoid,
      setActive: resolvedVoid,
      onOutput: subscribe,
      onExit: subscribe,
      onRunCommand: subscribe
    },
    git: {
      isAvailable: () => resolved(true),
      status: () => resolved({ staged: [], unstaged: [] }),
      changeStats: () => resolved(scenario2.changeStats ? { ...scenario2.changeStats } : null),
      threadChangeSummary: (refs) => resolved(
        refs.map(({ threadId }) => {
          const changes = scenario2.threadChanges?.[threadId];
          return changes ? { ...changes } : null;
        })
      ),
      onWorkingTreeChanged: subscribe,
      fileDiff: () => resolved(null),
      workingFileDiff: () => resolved(null),
      committedChanges: () => resolved(null),
      committedFileDiff: () => resolved(null),
      currentBranch: () => resolved(currentBranch),
      // These take (projectId, threadId, …) — dropping the leading two made
      // `branchStatus` answer with the *project id* as the current branch, which
      // reads as a branch mismatch and blocks every send behind the composer's
      // "this thread is for branch …" guard.
      branchStatus: (_projectId, _threadId, forBranch) => resolved({
        currentBranch: forBranch ?? currentBranch,
        pr: null
      }),
      // The demo has no linked worktrees, so there is never a detached one.
      worktreeAttachment: () => resolved({ state: "attached" }),
      reattachWorktree: () => Promise.reject(new Error("The demo has no thread worktrees")),
      restoreWorktree: () => Promise.reject(new Error("The demo has no thread worktrees")),
      promptState: () => resolved({ startingCommit: null, dirty: false }),
      checkoutBranch: (_projectId, _threadId, branch) => {
        currentBranch = branch;
        return resolvedVoid();
      },
      listBranches: () => resolved([
        { name: currentBranch, lastCommitDate: DEMO_TIME },
        { name: "main", lastCommitDate: DEMO_TIME }
      ]),
      getDefaultBranch: () => resolved("main"),
      sessionBackup: () => resolved(null),
      restoreBackup: () => resolved(false)
    },
    gh: {
      status: () => resolved({
        installed: Boolean(scenario2.pullRequests),
        authenticated: Boolean(scenario2.pullRequests),
        username: null,
        message: "Unavailable in browser demo"
      }),
      invalidateReadCache: resolvedVoid,
      setListWatch: resolvedVoid,
      onListsTick: subscribe,
      listMyOpenPrs: () => resolved([]),
      listWorkspaceOpenPrs: () => resolved(scenario2.pullRequests ?? []),
      prChecks: () => resolved("no_checks"),
      prDetails: (owner, repo, number) => resolved(
        scenario2.pullRequests?.find(
          (pr) => pr.owner === owner && pr.repo === repo && pr.number === number
        ) ?? null
      ),
      prFileDiff: () => resolved(null),
      resolvePrUrl: () => resolved(null),
      agentPrLinks: emptyArray,
      prThreadRelationships: (pr) => resolved(new ThreadPrRelationshipIndex(threads).forPr(pr)),
      threadPrRelationships: (threadId) => resolved(new ThreadPrRelationshipIndex(threads).forThread(threadId)),
      createPrForThread: () => resolved({ ok: false, message: "Unavailable in demo", backend: "mock" }),
      rerunFailedRuns: () => resolved({ ok: false, message: "Unavailable in demo", backend: "mock" }),
      approvePr: () => resolved({ ok: false, message: "Unavailable in demo", backend: "mock" }),
      markPrReady: () => resolved({ ok: false, message: "Unavailable in demo", backend: "mock" }),
      enableAutoMerge: () => resolved({ ok: false, message: "Unavailable in demo", backend: "mock" })
    },
    shell: { openExternal: resolvedVoid, openWorkspaceFileInBrowser: resolvedVoid },
    editors: {
      list: () => resolved({ editors: [], lastUsedId: null }),
      open: resolvedVoid
    },
    panes: {
      popout: (mode) => {
        const root = document.documentElement;
        const expanded = root.dataset["demoExpandedPane"] === mode;
        const button = document.querySelector(
          `.pane-popout-btn[data-pane-mode="${mode}"]`
        );
        if (expanded) {
          root.classList.remove("is-demo-pane-expanded");
          delete root.dataset["demoExpandedPane"];
          const placement = expandedPaneButtons.get(mode);
          if (placement) {
            if (placement.nextSibling?.parentNode === placement.parent) {
              placement.parent.insertBefore(placement.button, placement.nextSibling);
            } else {
              placement.parent.append(placement.button);
            }
            expandedPaneButtons.delete(mode);
          }
        } else {
          root.classList.add("is-demo-pane-expanded");
          root.dataset["demoExpandedPane"] = mode;
          const toolbar = document.querySelector(
            `#${mode}-viewer-host .browser-tab-panel.is-active .browser-toolbar`
          );
          if (mode === "browser" && button?.parentElement && toolbar) {
            expandedPaneButtons.set(mode, {
              button,
              parent: button.parentElement,
              nextSibling: button.nextSibling
            });
            toolbar.insertBefore(button, toolbar.querySelector(".browser-menu-wrap"));
          }
        }
        for (const button2 of document.querySelectorAll(
          `.pane-popout-btn[data-pane-mode="${mode}"]`
        )) {
          button2.replaceChildren(
            expanded ? maximizeIcon("ui-icon ui-icon-sm") : minimizeIcon("ui-icon ui-icon-sm")
          );
          button2.setAttribute("aria-label", `${expanded ? "Expand" : "Restore"} ${mode}`);
          button2.title = expanded ? "Expand pane" : "Restore app layout";
        }
        return resolvedVoid();
      },
      takePopoutSeed: () => Promise.resolve(null),
      onSwitchMode: () => () => {
      }
    },
    // The demo build has no main process to store a file, so attaching a video
    // rejects rather than handing back a path nothing could read.
    video: {
      attach: () => Promise.reject(new Error("Video attachments are unavailable in the demo")),
      read: () => Promise.reject(new Error("Video playback is unavailable in the demo"))
    }
  };
  return api;
}
var DEMO_MODEL, DEMO_TIME, DEMO_MCP_STATUSES, DEMO_TOOL_PERMISSIONS, DEMO_PLUGIN_CONTRIBUTIONS, DEMO_PLUGINS, DEMO_AUTOMATIONS_PLUGIN, DEMO_AUTOMATION_PERMISSIONS, emptyArray;
var init_demo_api = __esm({
  "src/renderer/demo/demo-api.ts"() {
    init_storage_cleanup();
    init_thread_pr_relations();
    init_thread_links();
    init_automations_plugin();
    init_parse_agent_run_payload();
    init_advisor_strategy_plugin();
    init_working_brief();
    init_trace_player();
    init_model_capabilities();
    init_token_estimate();
    init_files();
    init_unknown_value2();
    init_demo_scenarios();
    init_icons();
    DEMO_MODEL = "mock:demo";
    DEMO_TIME = "2026-07-17T09:00:00.000Z";
    DEMO_MCP_STATUSES = [
      {
        name: "proton-mcp",
        transport: "stdio",
        state: "connected",
        toolCount: 4,
        tools: ["list_mail", "get_mail_body", "send_mail", "delete_mail"],
        source: "/demo/copse/.mcp.json",
        origin: "project",
        originDetail: ".mcp.json",
        userEnabled: true,
        configDisabled: false
      }
    ];
    DEMO_TOOL_PERMISSIONS = {
      groups: [
        {
          id: "copse",
          name: "Copse tools",
          kind: "copse",
          tools: [
            {
              id: "copse:read-file",
              executionName: "read_file",
              name: "Read file",
              description: "Read a file in the active project.",
              policy: "allow",
              defaultPolicy: "allow",
              overridden: false
            },
            {
              id: "copse:run-shell",
              executionName: "run_shell",
              name: "Run shell command",
              description: "Run a command in the project sandbox.\n\nUse `run_shell` for tests and builds; use the dedicated file tools for inspection and edits.\n\n- Commands run in the active workspace.\n- Commands that need external access may require approval.\n\n```sh\npnpm test\n```",
              policy: "ask",
              defaultPolicy: "ask",
              overridden: true
            },
            {
              id: "copse:prepare-worktree",
              executionName: "prepare_worktree",
              name: "Prepare worktree",
              description: "Create an isolated checkout for a new thread.",
              policy: "ask",
              defaultPolicy: "ask",
              overridden: false,
              disabledPolicies: ["allow"],
              disabledReason: "Worktree preparation always requires approval."
            }
          ]
        },
        {
          id: "mcp:project:proton-mcp",
          name: "proton-mcp",
          kind: "mcp",
          origin: "project",
          originDetail: "/demo/copse/.mcp.json",
          status: "connected",
          tools: [
            {
              id: "mcp:project:proton-mcp:list-mail",
              executionName: "mcp__proton__list_mail",
              name: "List mail",
              description: "List messages in a mail folder.",
              policy: "allow",
              defaultPolicy: "ask",
              overridden: true
            },
            {
              id: "mcp:project:proton-mcp:get-mail-body",
              executionName: "mcp__proton__get_mail_body",
              name: "Get mail body",
              description: "Read the complete body of one message.",
              policy: "ask",
              defaultPolicy: "ask",
              overridden: false
            },
            {
              id: "mcp:project:proton-mcp:send-mail",
              executionName: "mcp__proton__send_mail",
              name: "Send mail",
              description: "Send a new mail message.",
              policy: "ask",
              defaultPolicy: "ask",
              overridden: false
            },
            {
              id: "mcp:project:proton-mcp:delete-mail",
              executionName: "mcp__proton__delete_mail",
              name: "Delete mail",
              description: "Delete a message from a mailbox.",
              policy: "block",
              defaultPolicy: "ask",
              overridden: true
            }
          ]
        }
      ]
    };
    DEMO_PLUGIN_CONTRIBUTIONS = {
      toolNames: [],
      modelRoutes: [],
      browserOrigins: [],
      blockingHooks: [],
      asyncHooks: [],
      commandHooks: [],
      promptBlocks: [],
      ui: [],
      followUps: [],
      capabilities: [],
      instructionSources: [],
      permissions: []
    };
    DEMO_PLUGINS = [
      {
        id: "copse.todos",
        trust: "first-party",
        stability: "stable",
        name: "Todos",
        version: "1.0.0",
        description: "Plan and track multi-step work inside a thread. Adds the `todo_write` tool, the plan panel, and the prompt block that teaches the agent when to keep a list.",
        enabled: true,
        contributions: { ...DEMO_PLUGIN_CONTRIBUTIONS, toolNames: ["todo_write", "todo_read"] },
        settings: []
      },
      {
        id: ADVISOR_STRATEGY_PLUGIN_ID,
        trust: "first-party",
        stability: "experimental",
        name: "Advisor strategy",
        version: "0.3.1",
        description: "Consult a larger advisor model mid-task via the advisor tool, forwarding the transcript and verified repo state for strategic guidance.",
        enabled: true,
        contributions: { ...DEMO_PLUGIN_CONTRIBUTIONS, toolNames: [ADVISOR_STRATEGY_TOOL_NAME] },
        settings: [
          {
            id: ADVISOR_MODEL_SETTING_ID,
            kind: "model",
            title: "Advisor model",
            description: "How to choose the model the advisor consults \u2014 re-derived from your configured providers each time it is called. A model assigned to the \u201Cadvisor\u201D role still takes precedence.",
            default: DEFAULT_ADVISOR_MODEL_ID,
            value: DEFAULT_ADVISOR_MODEL_ID
          }
        ]
      },
      {
        id: "copse.apple-development",
        trust: "first-party",
        stability: "experimental",
        name: "Apple Development",
        version: "1.0.0",
        description: "Build, test, and run enrolled local Apple projects with an installed Xcode.",
        enabled: false,
        contributions: {
          ...DEMO_PLUGIN_CONTRIBUTIONS,
          toolNames: [],
          ui: [
            {
              id: "apple-development",
              level: 3,
              slot: "thread-plugin-panel",
              title: "Apple Development"
            },
            {
              id: "apple-development-setup",
              level: 3,
              slot: "settings-plugin-detail",
              title: "Apple Development setup"
            }
          ]
        },
        settings: []
      },
      {
        id: "personal.reference-tools",
        trust: "user",
        stability: "experimental",
        name: "Reference tools",
        version: "0.1.0",
        description: "A locally installed plugin from a selected directory.",
        enabled: false,
        contributions: DEMO_PLUGIN_CONTRIBUTIONS,
        settings: []
      }
    ];
    DEMO_AUTOMATIONS_PLUGIN = {
      id: AUTOMATIONS_PLUGIN_ID,
      trust: "first-party",
      stability: "experimental",
      name: AUTOMATIONS_PLUGIN_ID,
      description: "Project-scoped cron schedules that start fresh, grouped, worktree-backed tasks while Copse is running.",
      enabled: true,
      contributions: {
        ...DEMO_PLUGIN_CONTRIBUTIONS,
        ui: [
          {
            id: "schedule-editor",
            level: 3,
            slot: "settings-plugin-detail",
            title: "Automation schedules"
          }
        ],
        storageNamespace: AUTOMATIONS_PLUGIN_ID
      },
      settings: []
    };
    DEMO_AUTOMATION_PERMISSIONS = [
      {
        permission: { kind: "copse-action", toolName: "gh_pr_create" },
        label: "Create pull requests",
        detail: "Pushes the current thread branch and opens a pull request in this project repository."
      },
      {
        permission: { kind: "copse-action", toolName: "gh_pr_rerun_failed_ci" },
        label: "Re-run failed CI",
        detail: "Re-runs failed checks for pull requests in this project repository."
      },
      {
        permission: { kind: "copse-action", toolName: "gh_pr_approve" },
        label: "Approve pull requests",
        detail: "Submits a GitHub approval for pull requests in this project repository."
      },
      {
        permission: { kind: "copse-action", toolName: "gh_pr_mark_ready" },
        label: "Mark pull requests ready",
        detail: "Moves draft pull requests in this project repository into review."
      },
      {
        permission: { kind: "copse-action", toolName: "gh_pr_enable_auto_merge" },
        label: "Enable pull request auto-merge",
        detail: "Enables the repository-preferred auto-merge strategy for a pull request."
      },
      {
        permission: { kind: "mcp-tool", toolName: "mcp__linear__create_issue" },
        label: "Create issue",
        detail: "Linear MCP \xB7 changes external data"
      },
      {
        permission: { kind: "mcp-tool", toolName: "mcp__linear__update_issue" },
        label: "Update issue",
        detail: "Linear MCP \xB7 changes external data"
      },
      {
        permission: { kind: "mcp-tool", toolName: "mcp__notion__create_page" },
        label: "Create page",
        detail: "Notion MCP \xB7 changes external data"
      },
      {
        permission: { kind: "mcp-tool", toolName: "mcp__slack__send_message" },
        label: "Send message",
        detail: "Slack MCP \xB7 may access external systems"
      },
      {
        permission: { kind: "mcp-tool", toolName: "mcp__figma__add_comment" },
        label: "Add comment",
        detail: "Figma MCP \xB7 changes external data"
      }
    ];
    emptyArray = () => Promise.resolve([]);
  }
});

// src/renderer/demo/scenarios.ts
function selectDemoScenario(search) {
  const requested = new URLSearchParams(search).get("scenario");
  const selected = DEMO_SCENARIOS.find((scenario2) => scenario2.id === requested);
  if (selected) return selected;
  const fallback = DEMO_SCENARIOS[0];
  if (!fallback) throw new Error("At least one browser demo scenario is required.");
  return fallback;
}
var init_scenarios = __esm({
  "src/renderer/demo/scenarios.ts"() {
    init_demo_scenarios();
  }
});

// src/renderer/demo/autoplay.ts
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitForElement(root, selector, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    if (signal?.aborted === true) return null;
    const found = root.querySelector(selector);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await sleep(POLL_MS);
  }
}
async function waitUntil(predicate, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    if (signal?.aborted === true) return false;
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(POLL_MS);
  }
}
function caretToEnd(el) {
  const selection = el.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
async function typeIntoComposer(composer, text, options = {}) {
  const {
    charsPerSecond = DEFAULT_CHARS_PER_SECOND2,
    instant = false,
    signal,
    focusComposer = true
  } = options;
  const emitInput = () => {
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  };
  if (focusComposer) composer.focus({ preventScroll: true });
  composer.textContent = "";
  emitInput();
  if (instant) {
    composer.textContent = text;
    caretToEnd(composer);
    emitInput();
    return;
  }
  const delay = 1e3 / charsPerSecond;
  const characters = [...new Intl.Segmenter().segment(text)].map((entry) => entry.segment);
  let typed = "";
  for (const [index, character] of characters.entries()) {
    if (signal?.aborted === true) return;
    typed += character;
    composer.textContent = typed;
    caretToEnd(composer);
    emitInput();
    await sleep(delay * (character === " " ? 1.6 : 0.75 + index % 5 / 8));
  }
}
async function playOnce(doc, options) {
  const composer = await waitForElement(
    doc,
    COMPOSER_SELECTOR,
    MOUNT_TIMEOUT_MS,
    options.signal
  );
  const submit = doc.querySelector(SUBMIT_SELECTOR);
  if (!composer || !submit) return false;
  await typeIntoComposer(composer, options.prompt, {
    ...options.charsPerSecond === void 0 ? {} : { charsPerSecond: options.charsPerSecond },
    ...options.instant === void 0 ? {} : { instant: options.instant },
    ...options.signal === void 0 ? {} : { signal: options.signal },
    ...options.focusComposer === void 0 ? {} : { focusComposer: options.focusComposer }
  });
  if (options.signal?.aborted === true) return false;
  await sleep(options.instant === true ? 0 : 320);
  submit.click();
  await waitUntil(() => submit.classList.contains(RUNNING_CLASS), 5e3, options.signal);
  return waitUntil(() => !submit.classList.contains(RUNNING_CLASS), RUN_TIMEOUT_MS, options.signal);
}
async function revealFinalPreview(doc, options = {}) {
  const links = doc.querySelectorAll(
    '.msg-assistant a[href^="http://"], .msg-assistant a[href^="https://"]'
  );
  const link = [...links].at(-1);
  if (!link) return false;
  link.click();
  const ready = await waitUntil(
    () => doc.querySelector(
      '#browser-viewer-host iframe.browser-webview[data-workspace-preview="ready"]'
    ) !== null,
    options.timeoutMs ?? PREVIEW_TIMEOUT_MS,
    options.signal
  );
  if (!ready) return false;
  const expand = doc.querySelector(
    '#browser-tabs-host .pane-popout-btn[aria-label^="Expand"]'
  );
  if (!expand) return false;
  expand.click();
  const expanded = await waitUntil(
    () => doc.documentElement.dataset["demoExpandedPane"] === "browser",
    options.timeoutMs ?? PREVIEW_TIMEOUT_MS,
    options.signal
  );
  if (!expanded) return false;
  await sleep(POLL_MS);
  doc.querySelector(".scroll-to-bottom")?.click();
  const transcript = doc.querySelector(".messages-list");
  const finalAssistantMessage = [...doc.querySelectorAll(".msg-assistant")].at(-1);
  if (transcript && finalAssistantMessage) {
    const box = transcript.getBoundingClientRect();
    const message = finalAssistantMessage.getBoundingClientRect();
    transcript.scrollTop += message.top + message.height / 2 - (box.top + box.height / 2);
  }
  if (doc.activeElement instanceof HTMLElement) doc.activeElement.blur();
  return true;
}
async function startAutoplay(doc, options) {
  const { signal } = options;
  const aborted = () => signal?.aborted === true;
  if (!options.instant) await sleep(options.startDelayMs ?? DEFAULT_START_DELAY_MS);
  const completed = await playOnce(doc, options);
  if (completed && options.revealFinalPreview === true) {
    await revealFinalPreview(doc, {
      ...signal === void 0 ? {} : { signal }
    });
  }
  if (options.loop !== true || !completed || aborted()) return;
  await sleep(options.loopPauseMs ?? DEFAULT_LOOP_PAUSE_MS);
  if (aborted()) return;
  doc.defaultView?.location.reload();
}
var COMPOSER_SELECTOR, SUBMIT_SELECTOR, RUNNING_CLASS, MOUNT_TIMEOUT_MS, RUN_TIMEOUT_MS, PREVIEW_TIMEOUT_MS, POLL_MS, DEFAULT_CHARS_PER_SECOND2, DEFAULT_START_DELAY_MS, DEFAULT_LOOP_PAUSE_MS;
var init_autoplay = __esm({
  "src/renderer/demo/autoplay.ts"() {
    COMPOSER_SELECTOR = ".prompt-input";
    SUBMIT_SELECTOR = ".submit-btn";
    RUNNING_CLASS = "with-stop";
    MOUNT_TIMEOUT_MS = 2e4;
    RUN_TIMEOUT_MS = 12e4;
    PREVIEW_TIMEOUT_MS = 2e4;
    POLL_MS = 60;
    DEFAULT_CHARS_PER_SECOND2 = 28;
    DEFAULT_START_DELAY_MS = 1200;
    DEFAULT_LOOP_PAUSE_MS = 2e4;
  }
});

// src/renderer/demo/main.ts
var require_main = __commonJS({
  "src/renderer/demo/main.ts"() {
    init_product_announcement_dialog();
    init_settings_dialog();
    init_announcement_fixtures();
    init_product_announcements();
    init_announcement_catalog();
    init_demo();
    init_demo_api();
    init_scenarios();
    init_autoplay();
    init_demo_scenarios();
    function flag(params2, name, fallback) {
      const raw = params2.get(name);
      if (raw === null) return fallback;
      if (raw === "") return true;
      return !["0", "false", "off", "no"].includes(raw.toLowerCase());
    }
    var params = new URLSearchParams(window.location.search);
    var scenario2 = selectDemoScenario(window.location.search);
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var autoplay = flag(params, "autoplay", scenario2.trace !== void 0);
    var embedded = flag(params, "embedded", false);
    useAnnouncementCatalog([]);
    window.api = createDemoApi(scenario2, { trace: { instant: reducedMotion } });
    document.documentElement.dataset["demoScenario"] = scenario2.id;
    if (scenario2.staticSite) document.documentElement.dataset["demoStaticSite"] = scenario2.staticSite;
    if (autoplay) document.documentElement.dataset["demoAutoplay"] = "on";
    if (embedded) document.documentElement.dataset["demoEmbedded"] = "on";
    void import("./chunks/main-AF2HPMMS.js").then(async (main) => {
      await main.rendererReady;
      if (scenario2.id.startsWith("product-announcements")) {
        await mountProductAnnouncements(
          window.api.settings,
          // `shipped` mounts the real catalog; every other scenario injects sample copy.
          scenario2.id === "product-announcements-shipped" ? PRODUCT_ANNOUNCEMENTS : DEMO_PRODUCT_ANNOUNCEMENTS,
          openSettingsDialog,
          scenario2.settings["onboardingCompleted"] !== true
        );
        document.documentElement.dataset["announcementsReady"] = "true";
      }
      const trace = scenario2.trace;
      if (!autoplay || !trace) return;
      void startAutoplay(document, {
        prompt: demoScenarioPrompt(scenario2),
        loop: flag(params, "loop", false),
        instant: reducedMotion,
        focusComposer: !embedded,
        revealFinalPreview: scenario2.revealFinalPreview === true
      });
    });
  }
});
export default require_main();
