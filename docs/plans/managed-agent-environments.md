# Bring-your-own Managed Agents environments

**Status: Proposed.** Nothing is implemented. This plan owns two things: a narrow
per-project settings overlay, and letting a Claude Cloud Agent turn run on a Managed
Agents environment the user supplies instead of one Copse creates.

## Outcome

Today every Claude Cloud Agent turn runs on an Anthropic-hosted sandbox that Copse
creates itself. `createEnvironment()` in
[`src/main/services/remote/managed-agents-client.ts`](../../src/main/services/remote/managed-agents-client.ts)
hardcodes `config: { type: 'cloud', networking: { type: 'unrestricted' } }`, and
`runManagedAgentFromSettings` calls it on every new session, so the environment is never
something the user can choose.

The Managed Agents API also accepts `config: { type: 'self_hosted' }`: the agent loop
stays on Anthropic's side, but tool execution — bash, file ops, code — runs on
infrastructure the user controls, reached by an outbound-polling worker. That is the seam
Cloudflare Sandboxes plug into (Cloudflare publishes a "Set up Claude Managed Agents"
guide for exactly this shape), and it is the only place Cloudflare fits Copse today.

The end state: a user pastes an `env_…` id for a project, and that project's Cloud Agent
turns run there. Copse ships no Cloudflare code and takes no Cloudflare dependency — it
stops assuming Anthropic-hosted compute and lets the user point somewhere else.

## Why Cloudflare Computer is not a provider

The question that started this plan was whether
[`@cloudflare/computer`](https://blog.cloudflare.com/cloudflare-computer/) could be added
as another cloud provider. It cannot, at any of the three seams that use that word:

- **LLM providers** (`CloudProvider` in `src/shared/types/ipc.ts`,
  `src/main/services/providers/`) — the wrong seam; this is not an inference product.
- **Remote agent providers** (`REMOTE_AGENT_PROVIDERS` in `src/shared/remote-agent.ts` —
  `cursor`, `anthropic`) — these are provider-managed agent services reached over REST +
  SSE with the user's API key. Cloudflare Computer has no equivalent endpoint to call; an
  adapter would mean building the agent service, not writing a client for one.
- **Cloud host provisioning** (`scripts/lib/cloud-hosts.mts`, AWS EC2 + Scaleway, and the
  proposed `CloudWorkspaceProvider` in [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md))
  — that core shells out to the `aws`/`scw` CLIs to launch SSH-reachable VMs, and its
  header says not to import it from `src/`. Cloudflare sandboxes are not that. More
  fundamentally, decision 1 of `copse-cloud-workspaces.md` is that a cloud workspace is
  "provisioner + SSH-remote workspace — **not** a second remote-execution path", and it
  explicitly rejects a docker-exec-style RPC transport. Cloudflare's RPC/FUSE model is the
  rejected alternative.

`@cloudflare/computer` is a library that runs inside Workers and Durable Objects — a
virtual filesystem in SQLite projected into a container or isolate — and is in preview
with explicitly unstable APIs. Its GA sibling, the Sandbox SDK, has the same deployment
model. Neither is a control plane an Electron app drives with an API token.

## What already exists to build on

- **The managed-agent adapter** — session create/stream/interrupt/usage, the repo-less
  path (`buildManagedAgentNoRepoSystemPrompt`, `hasRepo: false`), the launch notice, and
  the per-thread session store are all in `managed-agents-client.ts` already. The
  repo-less path in particular is wired end to end and is what a self-hosted environment
  reuses.
- **A single settings-overlay seam** — `getSetting` in
  [`src/main/services/storage/settings.ts`](../../src/main/services/storage/settings.ts)
  resolves through exactly one overlay (`getExplicitSettingsProfile()`), then the cached
  store, then the call-site fallback, validating against a per-key schema on read.
- **Per-project storage paths** — `projectStoreDir(projectId)` in
  `src/main/services/storage/copse-paths.ts` already resolves a per-project directory and
  rejects ids that escape the store root.
- **A guarded renderer write path** — `RENDERER_WRITABLE_SETTING_SCHEMAS` /
  `isRendererWritableSettingKey` in `settings-writable.ts` allowlist which keys a renderer
  may write, with schema validation on the way in.
- **A place to put the UI** — `#settings-claude-panel` in `settings-dialog.ts`, which the
  Providers panel relocates next to the Anthropic provider card.

## Decisions

1. **Cloudflare is reached through `self_hosted` environments, not through a Copse
   provider abstraction.** Copse's contribution is to stop hardcoding the environment.
   Everything Cloudflare-specific — the Worker, the sandbox, the polling worker — is the
   user's, deployed and operated outside Copse. This keeps a preview-stage,
   unstable-API dependency out of the desktop binary entirely.

2. **The environment id is per project, and user-local.** A worker built for one repo's
   toolchain is wrong for another, so a single global value does not fit. It is stored on
   the user's machine, not in the repo.

3. **Per-project config gets a narrow settings overlay, not a bespoke storage key.** The
   generic `storage:get`/`storage:set` IPC cannot carry it: `assertStorageKey` in
   `src/main/ipc/ipc-guards.ts` validates against an allowlist of exactly two literals
   (`projects`, `activeProjectId`). Widening that allowlist to admit arbitrary
   renderer-written keys would undo a deliberate guard. Instead, add a project layer at
   the one existing seam in `getSetting`, so resolution becomes **explicit profile →
   project overlay → global → fallback**, backed by `projectStoreDir(projectId)` and
   written through a scoped IPC that reuses the existing renderer-writable allowlist.

4. **The overlay is opt-in per key.** A `PROJECT_SCOPED_SETTING_KEYS` allowlist gates
   which keys consult the project layer, and it starts with one member
   (`remoteAgentEnvironmentId`). Every other setting behaves exactly as it does today.
   Keys migrate in individually when someone wants them, so this plan does not have to
   settle precedence semantics for ~70 settings it has no demand for.

5. **Not an in-repo `.copse/` file.** `.copse/hooks.json` is trust-gated
   (`hooks/copse-adapter.ts`) because repo-controlled config is an attack surface, and a
   file that redirects where the agent's compute runs is worse: a hostile repository could
   aim a session at an environment it controls, which then sees the user's prompts and
   code. The dividing line this plan adopts, and which the docs should state: **repo-
   authored, shared, trust-gated → files; user-authored, machine-local, security-sensitive
   → project settings.**

6. **Self-hosted environments are repo-less in v1.** On `self_hosted`, Anthropic does not
   mount `github_repository` resources — that is the worker's job. Sending the resource
   anyway would produce an agent looking for a checkout at `/workspace/repo` that is not
   there, and would put a GitHub token into a flow whose mount is not guaranteed. So Copse
   reads `config.type` once at session creation and, when it is `self_hosted`, takes the
   existing repo-less path: no `github_repository` resource, no GitHub token,
   `buildManagedAgentNoRepoSystemPrompt()`, `hasRepo: false`.

7. **The environment kind is surfaced before a turn runs, not after.** A Check control in
   Settings resolves the id and reports whether it is cloud (repo mounted as usual),
   self-hosted (repo not mounted), or unreachable. `buildLaunchNotice()` then names the
   environment in-thread, so the consequence appears where the work happens.

8. **Session reuse keys on the environment id.** `canReuse` currently compares provider,
   base URL, and model; without the environment id, changing the setting leaves live
   threads pinned to the old environment.

### Alternatives considered

- **Cloudflare as a `cloud-hosts.mts` provider** — rejected; see "Why Cloudflare Computer
  is not a provider" above. No VM-launch control plane, and the transport contradicts
  `copse-cloud-workspaces.md` decision 1.
- **Cloudflare as a `REMOTE_AGENT_PROVIDERS` entry** — rejected; there is no hosted agent
  API to adapt.
- **A bespoke `settings:setManagedEnvironmentForProject` channel** — rejected; it solves
  one key and becomes the precedent every later per-project setting copies badly.
- **Project scope for every renderer-writable setting at once** — deferred. Several are
  per-repo in spirit (`remoteAgentAutoCreatePR`, `remoteAgentWorkOnCurrentBranch`,
  `githubBackend`, `postTurnReviewMinChangedLines`, `model`, `browserAllowedOrigins`,
  `skillPluginPaths`, and the auto-approval/sandbox trust settings, where per-repo trust
  is the sharpest case), but none has demonstrated demand, and changing their semantics on
  the back of this feature is not warranted.
- **Reusing an environment Copse creates, across threads** — out of scope here. Copse
  creating one environment per session is real churn against a quota, but it is
  independent of this change and should be its own issue.

## Interface

All of it lives in `#settings-claude-panel` — Anthropic-only, so not the adjacent
`#settings-cloud-agent-options`, which is shared with Cursor. One row under the existing
API-key hint:

```
Sandbox environment
┌─────────────────────────────┐  ┌───────────────┐
│ env_…                       │  │ This project ▾│   [Check]
└─────────────────────────────┘  └───────────────┘
✓ Self-hosted environment — your worker provides the workspace; no repository is mounted.

Leave empty to let Copse create an Anthropic-hosted sandbox per session (the default).
A value set for this project overrides the all-projects value.
```

- Empty means default — no separate "use a custom environment" toggle, since the empty
  string is already the resolution rule.
- The scope dropdown (`This project` / `All projects`) is the general affordance for any
  project-scoped key, not a one-off for this field. On open it preselects whichever layer
  supplies the effective value, so the field always shows what is actually in force.
- Check reuses the button + status-span idiom already in the dialog
  (`lmstudio-test-row` / `lmstudio-test-status`). It needs a main-process IPC modelled on
  `settings:validateKey`, because the renderer never holds the Anthropic key.

## Phases

- **P1 — project settings overlay.** The per-project store under
  `projectStoreDir(projectId)`, the resolution seam in `getSetting`, the
  `PROJECT_SCOPED_SETTING_KEYS` allowlist, and `settings:getForProject` /
  `settings:setForProject` reusing `isRendererWritableSettingKey` and `zProjectId`.
  Self-contained and testable with no consumer.
- **P2 — environment resolution.** `remoteAgentEnvironmentId` schema, resolution
  (per-project → global → create as today), `GET /v1/environments/{id}`, the
  `self_hosted` branch onto the repo-less path, and the `canReuse` keying. Environment
  resolution takes an explicit project id rather than reading ambient state, matching the
  existing `launchProjectId` capture.
- **P3 — surfaces.** The Settings row above, its Check IPC, the launch-notice wording, and
  documenting the resolution order and self-hosted caveats in
  [`docs/remote-agents.md`](../remote-agents.md), whose provider table currently implies
  Anthropic-hosted compute is the only option.
- **P4 — follow-ups, not this plan.** Repo mounting on self-hosted environments; further
  keys opting into project scope; environment reuse across threads.

## Risks / open questions

- **Ambient project state in `getSetting`.** Consulting the active project inside a
  process-global getter means a background job for one project could read another's value
  after a switch. The opt-in allowlist bounds the exposure, and P2 avoids it at this call
  site by passing the project id explicitly — but the hazard is inherent to the seam and
  should be documented for every key that opts in later.
- **Two mechanisms for project config.** Files (`AGENTS.md`, `.cursor/rules`,
  `.copse/hooks.json`, `.mcp.json`, surfaced read-only under Settings → Sources) already
  serve project configuration. Adding a settings overlay means two answers to "how do I
  configure this per project", and the split in decision 5 has to be stated in the docs or
  it will be re-litigated.
- **Trust boundary on self-hosted environments.** Tool execution moves to infrastructure
  Copse does not control and cannot attest. That is the user's own infrastructure by
  construction, but [`threat-model.md`](../threat-model.md) already names
  "managed-runtime overclaim" as a hazard, and its description of the managed-agent
  runtime needs updating rather than silently widening.
- **Cloudflare's APIs are preview-stage.** `@cloudflare/computer` documents unstable APIs.
  Nothing in this plan depends on them — the contract Copse relies on is Anthropic's
  `self_hosted` environment type — but the user-facing story does depend on Cloudflare's
  own guide staying accurate.
- **Repo-less self-hosted may be too restrictive to be useful.** The main draw of a
  self-hosted sandbox is running the user's own toolchain against their repo. v1
  deliberately does not mount the repo, which may make the feature interesting to fewer
  people than expected; P4 should be judged on real use, not assumed.
