# Library splits

Tracking: [#2303](https://github.com/copse-dev/agent-pane/issues/2303)

Status: **Active.** Steps 2 to 5 of the suggested order are on `main`: `@copse/std`
([#2315](https://github.com/copse-dev/agent-pane/pull/2315)), `@copse/shell-guard`
([#2316](https://github.com/copse-dev/agent-pane/pull/2316)), `@copse/thread-store`
([#2317](https://github.com/copse-dev/agent-pane/pull/2317)), and `@copse/hooks-dialects`
([#2319](https://github.com/copse-dev/agent-pane/pull/2319)), all as in-repo workspace packages
with the app importing through re-exports. Each remaining step has its own sub-issue under
#2303. The measurements below were taken against `main` at `fb887be31` on 2026-09-03, before
any of those landed.

## Question

Which parts of `agent-pane` could be their own micro-library, or a bigger separate
project, and what does each cut cost in restructuring? A second question rides along:
how would a Qwen Code harness sit under the same UI as another backend?

## Verdict

Four packages have already left the app: `@copse/streaming-markdown` (its own repo,
[#689](https://github.com/copse-dev/agent-pane/pull/689)), `@copse/llm`
([#715](https://github.com/copse-dev/agent-pane/pull/715)), `@copse/agent`, and
`@copse/plan-usage`, the last three as in-repo workspace packages made real by
[#2000](https://github.com/copse-dev/agent-pane/pull/2000).

The next cuts with the best value-to-effort ratio are the **shell command classifier**,
the **thread-store format**, the **hook dialect adapters**, and the **ACP client core**.
All four have documented contracts already, few outward imports, and no Electron. The one
structural move that pays for everything else is a **client/server split**: only 30 of 474
main-process files touch Electron, the renderer reaches main through one typed seam, and
the Tauri sidecar already runs main as plain Node.

Qwen Code is **one catalog entry, not a new backend**. It speaks ACP with `qwen --acp`,
and Copse is already an ACP client with a per-agent quirk matrix.

## Method

Counts exclude tests. "Outward" is the number of relative imports that leave a candidate
directory into the rest of `src/`; workspace and npm imports are excluded. "Electron
files" is the number of source files importing from `electron`. LOC are raw line counts.
Effort estimates are judgement, not measurement.

## How the code is distributed today

| Area           | Files |     LOC | Electron files | Notes                                                                                                                                                                 |
| -------------- | ----: | ------: | -------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main`     |   474 | 100,113 |             30 | `services/` is 87k of it, in 26 subdirectories plus 60 top-level files. Electron use concentrates in `windows/` (9) and `ipc/` (5).                                   |
| `src/renderer` |   195 |  53,049 |              0 | Vanilla TypeScript DOM, no framework. `views/` is 40k. Every view receives `api: ApiClient`; only `src/renderer/main.ts` reads `window.api`.                          |
| `src/shared`   |   145 |  18,309 |              0 | Isomorphic. Several subdirectories have zero outward imports and are already library-shaped.                                                                          |
| `src/preload`  |     4 |   2,498 |              — | `api.d.ts` (1,043 lines) plus `shared/types/ipc.ts` (586) is the de facto client/server protocol.                                                                     |
| `src/sidecar`  |     9 |   1,425 |              2 | Tauri prototype: runs `src/main` unchanged as plain Node via an esbuild alias of `electron` to a shim, with a loopback WebSocket for renderer IPC.                    |
| `scripts/`     |   161 |  31,323 |              — | About 11.8k is bench and eval harness; 4.8k is test infrastructure (oracle, screenshots, remote e2e, runner burst).                                                   |
| `packages/`    |     — |       — |              0 | `@copse/llm`, `@copse/agent`, `@copse/plan-usage` as in-repo workspace packages; `extract-zip` as a vendored shim. `@copse/streaming-markdown` lives in its own repo. |

## What has already been cut, and the pattern it set

The markdown renderer went first and became a standalone repo consumed as a dependency.
The app keeps only glue in `src/renderer/markdown/` and injects a link decorator, an
image renderer, and a sanitizer extension. `@copse/llm`, `@copse/agent`, and
`@copse/plan-usage` followed the same two-stage path. That gives a repeatable recipe:

1. Stage as `packages/<name>` with `exports` exposing source subpaths, added to
   `WORKSPACE_PACKAGES` in `scripts/workspace-package-invariants.test.ts`.
2. Zero imports from the host app. Where the module reads app state today, it takes an
   options object or a small interface instead.
3. Graduate to its own repository as a git or npm dependency once the API stops moving.
   App imports do not change at that point.

Two frictions showed up in the measurements and will recur on every extraction:

- **Leaf utilities have no home.** `shared/unknown-value` is imported by 102 source files
  and 33 scripts, `shared/safe-json` by 21. `@copse/agent` vendored its own copies of `at`
  and `errorMessage` to stay host-free. A tiny `@copse/std` package stops that duplication
  compounding.
- **`services/storage/settings.ts` is the hub.** Providers import it 19 times, security 7,
  ACP 4, SSH 4. Every extraction below either takes settings as a parameter or defines a
  narrow reader interface. Settings itself stays in the app.

## Candidate register

Effort scale: **Easy** is days and mechanical, mirroring the plan-usage extraction.
**Medium** is one to two weeks and needs injected seams or a small interface. **Hard** is
multi-week, architectural, and touches a binding security or plan document.

### A. Micro-libraries (pure or nearly pure)

| Candidate                                        | Source today                                                                                     |    LOC | Outward | Effort | Value   | What blocks it                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -----: | ------: | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaf utilities (`@copse/std`)                    | `shared/unknown-value`, `safe-json`, `array-utils`                                               |   ~400 |       0 | Easy   | Enabler | Nothing. Do it first so later packages stop vendoring copies.                                                                                                               |
| Shell command classifier (`@copse/shell-guard`)  | `security/shell-argv`, `shell-scope`, `shell-harm`, `command-routing`                            | ~3,000 |       4 | Medium | High    | `shell-scope` reads two path roots; `shell-harm` reaches into auto-approval. Both become options. Contract is `docs/shell-permissions.md`.                                  |
| Thread store format (`@copse/thread-store`)      | `shared/threads`, `shared/store`, `services/thread-store.ts`                                     | ~6,100 |       6 | Medium | High    | Shared halves are pure (1 outward each). `thread-store.ts` needs a root directory and a write queue injected. Format is a stable contract in `docs/thread-store-format.md`. |
| Hook dialect adapters (`@copse/hooks-dialects`)  | `services/hooks/{cursor,claude,copse,dialect}-adapter`, `hook-spawn`, `shared/hooks`, hook types | ~4,000 |      28 | Medium | High    | Platform half is already in `@copse/agent/hooks`. The recorder (12 imports) and execution-root (5) become interfaces. `docs/plans/hooks-and-feature-packs.md` is binding.   |
| PII redaction (`@copse/pii`)                     | `@copse/agent/plugins/pii-redaction-plugin`, `security/pii-redactor`                             |   ~600 |       2 | Easy   | Medium  | Already host-free inside the agent package. Doc: `docs/pii-redaction.md`.                                                                                                   |
| Usage accounting (fold into `@copse/plan-usage`) | `shared/usage`                                                                                   |  1,123 |       0 | Easy   | Low     | Nothing. Same subject as the existing package.                                                                                                                              |
| Process diagnostics                              | `services/diagnostics`                                                                           |  1,668 |      13 | Easy   | Low     | Event-loop watchdog, startup budget, stdio guard, shutdown deadline are generic Node. Only `perf-ipc` touches Electron and stays.                                           |
| ACP agent catalog                                | `shared/acp-known-agents.ts`                                                                     |   ~350 |       0 | Easy   | Low     | Pure data by design. Its ids track the upstream ACP registry, so contributing sandbox presets upstream beats publishing a second catalog.                                   |

### B. Services with seams (cohesive, no Electron, wired into app state)

| Candidate                                        | Source today                                            |    LOC | Outward | Effort | Value  | What blocks it                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------- | -----: | ------: | ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP client host (`@copse/acp-host`)              | `services/acp` (40 files)                               | 10,129 |      84 | Hard   | High   | Splits roughly 60/40. Protocol client, negotiation, session pool, v2 adapter, wire tap, turn recovery, and the probes are extractable. The native-tool bridge, permission context, sandbox spawn, and SSH transport are Copse bindings and stay.   |
| Plugin tool SDK (`@copse/plugin-sdk`)            | `services/plugins` (13 files), `services/mcp` (7)       |  5,191 |      31 | Medium | High   | The worker protocol, SDK, host, and snapshot files are what a third party would import. The feature-pack marketplace plan (#1082) needs a publishable SDK regardless. One Electron import in the plugin browser panel.                             |
| SSH workspace transport (`@copse/ssh-workspace`) | `services/ssh-workspace` (24 files), `workspace-fs` (6) |  2,883 |      23 | Medium | Medium | Clean `transport.ts` interface with OpenSSH and fake implementations. Electron only in `ssh-prompt` and `ssh-workspace-ipc`. Needs settings and the credential cipher injected.                                                                    |
| Sandboxed execution (`@copse/sandbox-exec`)      | `main/project-sandbox` (13), `services/exec` (12)       |  4,143 |      38 | Hard   | High   | Wraps `@anthropic-ai/sandbox-runtime` with network scope, the sandbox-fs server and worker, subprocess kill and output caps. Bound by `docs/shell-permissions.md` and `docs/plans/execution-runtime-security.md`. Pairs with the shell classifier. |
| Code index and search (`@copse/code-index`)      | `services/search` (18 files)                            |  4,266 |      26 | Medium | Medium | File index, indexed grep, semantic index over the vendored gortex binary, ignore rules, watchers, worktree overlay. The gortex download step has to travel with it.                                                                                |
| GitHub CLI wrappers (`@copse/gh`)                | `services/github` (21 files)                            |  6,343 |      37 | Medium | Medium | Typed `gh` JSON wrappers with zod schemas, PR and CI services, git service. The CI investigator imports agent-service and dispatcher, so it stays behind.                                                                                          |
| Storage primitives                               | `services/storage` (28 files)                           |  3,677 |       9 | Easy   | Medium | Persistent and cached stores, write queue, secret cipher over the OS keyring, zip reader, usage ledger. The `electron-store` backend becomes one pluggable backend. Settings itself does not move.                                                 |
| Provider catalogs (fold into `@copse/llm`)       | `services/providers` (27 files)                         |  4,296 |      35 | Medium | Medium | OpenRouter, Hugging Face, LM Studio, and Artificial Analysis fetchers plus key detection and validation belong with the provider package. Selection and role logic reads settings 19 times and stays.                                              |
| Remote agent clients                             | `services/remote` (7 files)                             |  2,547 |      23 | Medium | Low    | Cursor cloud and managed-agent HTTP clients. Worth cutting only as part of a "backends" family alongside ACP.                                                                                                                                      |

### C. Bigger deals (separate products or repos)

| Candidate                                       | Source today                                                                              |     LOC |           Outward | Effort | Value     | What blocks it                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ------: | ----------------: | ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client/server split (`copse-core` + `copse-ui`) | `src/main` as a Node daemon; `src/renderer` as a web client                               |   ~150k | 30 Electron files | Hard   | Very high | The protocol exists as `preload/api.d.ts`; the shim exists as `src/sidecar`; the demo build proves the renderer runs without Electron. Missing: a versioned protocol contract and a `ShellHost` interface for the 30 files that use BrowserWindow, dialog, shell, etc. |
| UI kit and panes (`@copse/ui`)                  | `renderer/dom`, `renderer/ui`, git-diff viewer (Monaco), terminals pane (xterm), VNC pane |  ~6,000 |               low | Medium | Medium    | `docs/plans/ui-kit.md` is active: factory functions plus `.ui-*` CSS, no Shadow DOM. Each pane takes `api` as a parameter. Value rises sharply if the client/server split happens.                                                                                     |
| Bench and eval harness (`copse-bench`)          | `scripts/bench-*`, `run-*bench*`, `benchmarks/`                                           | ~13,400 |         6 modules | Medium | Medium    | Imports the app only through headless-agent-host, agent-prompt, spine-schema, fold, and shell-argv. The headless automation contract (#1079) names bench as its first conformance consumer; once that lands this is its own repo and `scripts/` shrinks by a third.    |
| Dev and test tooling (`copse-devtools`)         | test oracle, screenshot checks, remote e2e, wdio helpers, `ci-runners/`                   |  ~4,800 |               low | Easy   | Low       | Nothing technical. Low urgency; mostly a repo-hygiene win.                                                                                                                                                                                                             |

### Not worth cutting

- `main/tools` (33 files, 3.7k LOC) has zero internal imports and 126 outward ones. It
  is glue by nature: every tool binds the runtime spine (execution root, thread models,
  workspace, execution context, diff queue). Extract the spine first, or not at all.
- `agent-service.ts`, `diff-queue.ts`, `worktree-manager.ts` are the product's
  orchestration and stay.
- Browser and computer-use tools drive Electron `webContents` directly. The VNC service is
  Electron-free but small and used by one pane.

## The four cuts worth starting

### Shell command classifier

~3,000 LOC; `shell-quote` is the only npm dependency; 4 outward imports; no Electron.

`shell-argv.ts` imports nothing but `shell-quote` and `node:path`. `shell-scope.ts` and
`shell-harm.ts` add scope analysis, harm classification, and routing on top, and are the
reason `docs/shell-permissions.md` exists. Any agent harness that runs shell commands needs
exactly this, and none of the open ones ship it as a library.

**Seam:** `shell-scope` reads the agent scratch roots and Copse paths; pass both as a
`roots` option. `shell-harm` reaches into auto-approval and read-outside-project for
policy inputs; hand those in as a decided `policy` value so the classifier stays pure.

### Thread store format

~6,100 LOC; `zod` is the only npm dependency; 6 outward imports; no Electron.

The spine schema, fold, decision log, prompt cause, deferred approvals, and thread
helpers are already pure. The on-disk layout under
`~/.copse/workspace/<projectId>/<threadId>/` is documented as a stable contract, and the
agent is told about it in the steering preamble. A library makes the same threads
readable by benches, exporters, and any second client, which
[`codex-oss-architecture-comparison.md`](codex-oss-architecture-comparison.md) already
asks for as "one versioned event model".

**Seam:** `thread-store.ts` imports the write queue, storage, and copse-paths. Take a
`rootDir` and a `WriteQueue` interface in the constructor. The one `@copse/llm` import
(tool-result images) is a workspace dependency already and can stay.

### Hook dialect adapters

~4,000 LOC; `micromatch` npm dependency; 28 outward imports; no Electron.

Cursor's `hooks.json`, Claude's settings hooks, and Copse's own dialect are each parsed,
mapped onto canonical events, and executed through `command-hook-runner`. The event
vocabulary and the executor registry already live in `@copse/agent/hooks`; the adapters
are the missing half.

**Seam:** `hook-run-recorder` is imported 12 times; make it a `HookRunSink` interface.
`execution-root` (5) becomes a resolved path argument. `hook-spawn` imports the project
sandbox; accept a `spawn` function so the sandbox stays a Copse concern. The hooks plan
document is binding and must change in the same PR.

### ACP client host

10,129 LOC in 40 files; `@agentclientprotocol/sdk`; 84 outward imports; no Electron.

The valuable part is not the SDK wrapper but the accumulated knowledge: protocol
negotiation, an in-memory resumable session pool, the v2 session adapter, turn recovery,
wire tap and trace, and a measured capability and behavior matrix per agent.
[`../acp-agents.md`](../acp-agents.md) records that Claude, Cursor, and Codex each fill in
different halves of a tool call's name and arguments, and Copse patches them together.

**Seam:** define an `AcpClientBindings` interface covering the five things Copse injects:
file reads, the write-to-diff-queue path, permission requests, MCP server list, and spawn
(local, sandboxed, or over SSH). The native-tool bridge, permission grants, approval
presentation, and remote-env gate stay in the app as the implementation of that
interface. The probes and matrix renderer are already pure functions and run from
standalone scripts today. `acp-agent-server` and `acp-app-entry` (Copse as an ACP agent)
belong with the headless contract instead.

## The bigger move: main process as a daemon, renderer as a client

Three facts make this smaller than it sounds. Only 30 of 474 main-process files import
Electron, and the symbols they use are a short list: `ipcMain`, `app`, `BrowserWindow`,
`WebContents`, `shell`, `dialog`, `session`, `safeStorage`, `nativeTheme`,
`Notification`, `Menu`, `globalShortcut`. The renderer talks to main through one typed
surface, `preload/api.d.ts`. And the Tauri sidecar already runs the whole main process as
plain Node by aliasing `electron` to a shim and carrying IPC over a loopback WebSocket.

What is missing is not code but commitment: the `ApiClient` surface is a type, not a
versioned protocol, and the Electron-touching services call into windows directly instead
of through a host interface. The Codex comparison recommends exactly this as its third
decision: expose the runtime through a generated, capability-aware protocol shared by IPC
and ACP. [`headless-automation-contract.md`](headless-automation-contract.md) is the same
idea from the automation side.

Sequence that keeps the app shipping throughout:

1. Generate a JSON Schema from `api.d.ts` and `ipc.ts`, publish it, and add an invariants
   test so the surface only changes deliberately.
2. Introduce `ShellHost` for window, dialog, shell-open, notification, secure storage, and
   theme. Electron implements it; the sidecar shim becomes a second implementation instead
   of a module alias.
3. Promote the sidecar WebSocket bridge from prototype to a supported transport, so
   `src/renderer` can be served to a browser tab.
   [`mobile-web-experience.md`](mobile-web-experience.md) gets its foundation for free.
4. Only then split repositories. `copse-core` becomes a daemon with three front doors:
   Electron IPC, WebSocket, and ACP (the headless agent server in `acp-app-entry.ts`
   already exists).

This is also what makes a whole harness swappable underneath the UI, which is the deeper
version of the Qwen question below.

## Qwen Code as a backend

Copse already routes turns to three kinds of backend from `agent-dispatcher.ts` and
`agent-service.ts`: the native loop in `@copse/agent`, external ACP agents selected as
`acp:<id>`, and Cursor cloud agents as `remote-agent:*`. Qwen Code offers three
integration surfaces, and they map onto those three options with very different costs.

| Route                                     | Effort       | Assessment                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. ACP subprocess** (recommended)       | About a day  | Qwen Code is a Gemini CLI fork and launches in ACP mode with `qwen --acp`. Zed's agent registry lists it. Add a `KNOWN_ACP_AGENTS` entry mirroring `gemini`, then run `pnpm run probe:acp` and `probe:acp:behavior`. Keeps the diff queue, permission gate, sandbox, and native bridge.                                                                                                      |
| 2. stream-json / `@qwen-code/sdk`         | 1 to 2 weeks | Headless mode speaks a Claude-Code-SDK-shaped protocol (`--output-format stream-json`, `--input-format stream-json`, `--include-partial-messages`, `--resume`, `--approval-mode`). A fourth dispatcher backend with a chunk adapter. Qwen marks stream-json input as under construction; permissions are pre-decided by `--approval-mode`, so Copse loses its per-call gate. Duplicates ACP. |
| 3. In-process `@qwen-code/qwen-code-core` | Multi-week   | Embed Qwen's core (0.0.14) as an alternative loop behind `AgentHost`. Brings its own config, tool registry, and `~/.qwen` settings; bypasses `ToolRegistry`, the permission gate, and the diff queue, which is the exact thing the ACP design avoids. Only sensible if the goal is to replace the native loop.                                                                               |

### Route 1 in concrete terms

A first-cut entry, placed after `gemini` in `src/shared/acp-known-agents.ts`. Auth env
names and the sandbox domain list are marked to verify: Qwen Code supports Qwen OAuth and
OpenAI-compatible keys, and the exact hosts should come from a wire trace with
`COPSE_DEBUG_ACP_UPDATES` rather than from memory.

```ts
{
  id: 'qwen-code', // match the ACP registry id before shipping
  title: 'Qwen Code',
  command: 'qwen',
  args: ['--acp'],
  envHints: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'], // verify
  install: 'npm install -g @qwen-code/qwen-code',
  installPackage: '@qwen-code/qwen-code',
  autoInstall: true,
  sandbox: {
    allowedDomains: [/* from a network probe: qwen.ai and dashscope hosts */],
    homeDirs: ['.qwen'],
  },
  setup: 'qwen', // first run walks through Qwen OAuth or reads the env key
  docsUrl: 'https://qwenlm.github.io/qwen-code-docs/',
  note: 'Sign in by running `qwen` once, or set OPENAI_API_KEY and OPENAI_BASE_URL.',
}
```

Two things to check during the probe run. Upstream issue
[QwenLM/qwen-code#2015](https://github.com/QwenLM/qwen-code/issues/2015) reported that
mode switching and session management over ACP did not match the protocol shape Zed
expected, so the session-modes and session-load rows of the support matrix may come back
empty. And Qwen's own docs note that `--yolo` does not enable a sandbox; the seatbelt
preset in the catalog entry is what covers that on macOS.

## Suggested order

Ordered so each step removes a blocker for the next. The Qwen entry is independent and
can land any time.

1. Qwen Code catalog entry and probe run. One day; proves the ACP path once more.
2. `@copse/std` leaf utilities. Stops every later package vendoring `unknown-value` and
   `safe-json`.
3. `@copse/shell-guard`. Pure, documented, high reuse. Establishes the "policy in, verdict
   out" style the sandbox package will follow.
4. `@copse/thread-store`. Gives the bench harness and any second client a stable read path
   to threads.
5. `@copse/hooks-dialects`. Completes the hooks platform that `@copse/agent/hooks`
   started; update the binding plan alongside.
6. `@copse/plugin-sdk`. Required by the marketplace plan anyway; publish the worker
   protocol and SDK, keep the host in-app.
7. `@copse/acp-host`. After the bindings interface is designed. Fold the remote-agent
   clients into the same "backends" family if it helps.
8. Headless contract, then `copse-bench` as its own repo. Removes a third of `scripts/`
   from the app.
9. Versioned API protocol and `ShellHost`, then the client/server split. The Tauri sidecar
   and the mobile-web plan both land on this.

## Sub-issues

One per step of the suggested order, all children of
[#2303](https://github.com/copse-dev/agent-pane/issues/2303):

| Step | Issue                                                        | Scope                                                                       |
| ---: | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
|    1 | [#2304](https://github.com/copse-dev/agent-pane/issues/2304) | Qwen Code catalog entry and probe run                                       |
|    2 | [#2305](https://github.com/copse-dev/agent-pane/issues/2305) | `@copse/std` leaf utilities — landed in #2315                               |
|    3 | [#2306](https://github.com/copse-dev/agent-pane/issues/2306) | `@copse/shell-guard` — landed in #2316                                      |
|    4 | [#2307](https://github.com/copse-dev/agent-pane/issues/2307) | `@copse/thread-store` — landed in #2317                                     |
|    5 | [#2308](https://github.com/copse-dev/agent-pane/issues/2308) | `@copse/hooks-dialects` — landed in #2319                                   |
|    6 | [#2309](https://github.com/copse-dev/agent-pane/issues/2309) | `@copse/plugin-sdk`                                                         |
|    7 | [#2310](https://github.com/copse-dev/agent-pane/issues/2310) | `@copse/acp-host`                                                           |
|    8 | [#2311](https://github.com/copse-dev/agent-pane/issues/2311) | `copse-bench` as its own repository, after the headless contract (#1079)    |
|    9 | [#2312](https://github.com/copse-dev/agent-pane/issues/2312) | Versioned API protocol, `ShellHost`, then the client/server split           |
|    — | [#2313](https://github.com/copse-dev/agent-pane/issues/2313) | Small folds: usage, provider catalogs, PII, storage primitives, diagnostics |

## Sources for the Qwen Code section

- [Qwen Code docs: Zed Editor integration](https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/)
  (command and args)
- [Qwen Code docs: Headless mode](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)
  (stream-json, approval modes, resume)
- [Zed ACP registry: Qwen Code](https://zed.dev/acp/agent/qwen-code)
- [QwenLM/qwen-code#2015](https://github.com/QwenLM/qwen-code/issues/2015) (ACP mode
  switching and session management)
- [@qwen-code/qwen-code-core on npm](https://www.npmjs.com/package/@qwen-code/qwen-code-core)
  and [@qwen-code/sdk on npm](https://www.npmjs.com/package/@qwen-code/sdk)
- [Agent Client Protocol: agents](https://agentclientprotocol.com/get-started/agents)

## Related

[`../acp-agents.md`](../acp-agents.md), [`acp-client-support.md`](acp-client-support.md),
[`codex-oss-architecture-comparison.md`](codex-oss-architecture-comparison.md),
[`headless-automation-contract.md`](headless-automation-contract.md),
[`hooks-and-feature-packs.md`](hooks-and-feature-packs.md),
[`feature-pack-marketplace.md`](feature-pack-marketplace.md), [`ui-kit.md`](ui-kit.md),
[`tauri-servo-migration.md`](tauri-servo-migration.md),
[`../thread-store-format.md`](../thread-store-format.md),
[`../shell-permissions.md`](../shell-permissions.md),
[`../../packages/agent/README.md`](../../packages/agent/README.md).
