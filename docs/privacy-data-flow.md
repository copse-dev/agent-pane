# Privacy and data flow

Copse is an Electron desktop application with no Copse-hosted backend and no
product telemetry. That does **not** mean all activity is local: data is sent
directly to model providers, remote agents, MCP servers, SSH hosts, websites,
and update infrastructure when the corresponding feature is configured or used.
A few automatic checks also run without a separate user action — the update
feed and its release notes, coding plan usage, model-card lookups, and ACP
adapter version checks — and are listed in the table below. None of them sends
prompts or code.

This document describes the application behavior. A third-party service's own
terms, retention, logging, and training policies apply after data reaches it —
[provider-data-policies.md](provider-data-policies.md) records what each
supported model provider retains and trains on by default, and the
request-level protections Copse enables (ZDR-only OpenRouter routing,
OpenAI `store: false`).

Experimental local container runs (`containerRunsEnabled`, off by default) add a
separate execution path: the headless host and workspace snapshot run inside a
hardened Docker guest, with a selected provider credential and host-brokered egress.
Host GitHub credentials and the rest of the host environment are not copied into
the guest. Result transcripts, review records and carry-out Git bundles persist
under the profile's `runtimes/` directory; adoption into the checkout is explicit.
The guest/provider and dependency-download flows can leave the device through the
configured egress rules. See [the container contract and its credential limits](plans/thread-in-container.md).

## Data-flow summary

| Feature                                 | Destination                                                                                                                                                            | Data that can leave the device                                                                                                                                                                                                                                                                                                                              | Local record and control                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud and custom LLM providers          | The configured provider API                                                                                                                                            | User prompts and images; conversation context; system instructions; tool definitions, arguments and results; and source or file content included in the turn                                                                                                                                                                                                | Requests originate in the main process. Provider responses and tool activity are saved in the local thread. Selecting a local provider keeps this flow at its configured local endpoint.                                                                                                                                                                      |
| Remote agents                           | Cursor or Anthropic agent services, plus a configured GitHub repository when attached                                                                                  | Current prompt and images; on first handoff, up to 16,000 characters of prior user/assistant text (tool-call-only turns omitted), up to 5 images total (current-turn first, then most recent prior), and the current branch; repository URL/branch; and, for a repo-backed Claude Agent session, a GitHub token used by the service to mount the repository | Remote session identifiers and returned transcript/tool events are stored locally. The remote service may clone, modify, push, or open a PR for the repository according to the selected settings.                                                                                                                                                            |
| MCP                                     | A configured local stdio process or remote HTTP server                                                                                                                 | MCP tool arguments, which may contain prompt-derived text, file content, paths or other workspace data; configured environment values; and protocol metadata                                                                                                                                                                                                | Tool results pass back through Copse and are stored in thread history. Project MCP configuration is workspace-trust gated; server spawn and tool use follow the MCP approval settings. The server controls its own network access and retention.                                                                                                              |
| ACP agents                              | A configured external agent process on the same machine, or on an SSH host when agents on the remote machine are enabled; any services that process chooses to contact | Prompt text/images, the workspace path, selected MCP server configuration, and requests/results for tools exposed through the optional localhost native-tool bridge                                                                                                                                                                                         | Copse strips its provider secrets from the inherited base environment. Values explicitly placed in an ACP agent's `env` are still passed to it. The ACP program may have its own credentials, storage, network behavior, and privacy policy.                                                                                                                  |
| Interactive browser                     | The websites the user opens                                                                                                                                            | Ordinary browser requests, entered form data, cookies, and other site interactions. Page text, screenshots, or selected text become model-bound thread attachments only when the user explicitly shares them                                                                                                                                                | Uses a persistent `copse-browser` profile isolated from the main renderer. Website storage remains on disk until the browser profile is cleared or removed; explicit browser shares use the same removable composer chips as pasted text and images.                                                                                                          |
| Agent browser tools                     | Approved website origins                                                                                                                                               | Browser requests and agent-entered data. Page snapshots, screenshots, and interaction results can then be sent to the selected model as tool results                                                                                                                                                                                                        | Uses a separate persistent `copse-browser-agent` profile, so automation does not inherit interactive-browser logins. Screenshot pixels and resolvable handles stay in bounded, session-only memory unless the built-in agent explicitly publishes a screenshot or before/after comparison; published pixels are copied into the owning thread.                |
| Environment-key scan                    | The local main process only                                                                                                                                            | Nothing during the scan                                                                                                                                                                                                                                                                                                                                     | The scan runs only after the user chooses it. It reads `process.env` and a fixed allow-list of shell startup files, then sends only masked previews to the renderer. Importing a discovered key stores it under the same rules as a manually entered key.                                                                                                     |
| Automatic updates                       | The `copse-dev/copse-releases` GitHub Releases feed, and `api.github.com` for that repository's release notes                                                          | The normal metadata of a GitHub update request, including network address and current app/version information required by the updater; the release-notes request is unauthenticated and sends `User-Agent: copse-panel`                                                                                                                                     | Packaged macOS builds check on launch and on Check for Updates. Release notes are fetched only when an update is available, to show what changed. Copse asks before downloading; a downloaded update installs on restart or the next quit. Development builds do not check the feed.                                                                          |
| Coding plan usage                       | `api.anthropic.com`, `chatgpt.com`, `cursor.com`, and `huggingface.co` usage endpoints                                                                                 | Each OAuth or session token goes only to the service that issued it: the Claude Code token (Keychain item or `~/.claude/.credentials.json`) to Anthropic, the Codex token (`~/.codex/auth.json`) to ChatGPT, the Cursor token (Keychain item or Cursor's `state.vscdb`) to Cursor, and a Hugging Face token to Hugging Face                                 | Automatic, with no setting: runs when Settings → Usage opens and when the default best-value chat model (or another rule-based selector) is resolved at thread open or agent run, cached for five minutes. Recent usage samples are stored locally. Choosing a concrete chat model avoids the per-thread check.                                               |
| Model-card lookups                      | `huggingface.co` and model vendors' public model-card pages                                                                                                            | HEAD/GET requests whose URL names a model; the user's network address                                                                                                                                                                                                                                                                                       | Runs when the Settings → Usage value chart renders or is hovered. Results are cached in `settings.json` (`modelCardProbeCache`: successes 30 days, failures 1 day, at most 512 entries).                                                                                                                                                                      |
| ACP adapter checks                      | The npm registry; Socket Firewall for approved installs                                                                                                                | Package names in `npm view <pkg> version`; an approved install downloads the pinned adapter                                                                                                                                                                                                                                                                 | Version checks run when the ACP agents settings open. Installs need approval and run through Socket Firewall locally; remote installs over SSH are separately approved and do not use Socket Firewall.                                                                                                                                                        |
| SSH workspaces                          | The configured SSH host, through system OpenSSH                                                                                                                        | Shell, terminal, Git, search and file operations and the file content they involve; with agents on the remote machine enabled, the ACP agent's prompts and tool traffic, and its configured keys only after an approval dialog                                                                                                                              | Off by default (`sshWorkspaceEnabled`, `acpOverSshEnabled`; Settings → SSH). ControlMaster sockets live under `/tmp/copse-ssh-<uid>`. Remembered SSH passwords and passphrases are stored encrypted in the `ssh-credentials` store.                                                                                                                           |
| Mobile Companion                        | A phone the user pairs, on the local network only                                                                                                                      | Project names, thread titles, state and activity; the last 40 messages per thread (each up to 20,000 characters); pending approval and question text. A phone granted control can approve or deny, answer questions, stop runs, and send messages that run against the user's model                                                                         | Off by default (Settings → Experimental). HTTPS on one chosen private IPv4 address, port 42773; pairing needs a code and desktop approval. `~/.copse/lan/` holds the local root CA key and certificate, paired devices (with SHA-256 token hashes), and the on/off preference. Revoke phones or turn it off from the same settings.                           |
| Agent web search and fetch              | DuckDuckGo (`html.duckduckgo.com`); approved website origins                                                                                                           | The search query text; for `fetch_url`, a normal request to the approved origin                                                                                                                                                                                                                                                                             | DuckDuckGo is in the default allowed web origins, so `web_search` runs without a prompt unless web tools are set to ask. Results are stored in the thread as tool results.                                                                                                                                                                                    |
| Parallel search and Artificial Analysis | `api.parallel.ai`; `artificialanalysis.ai`                                                                                                                             | Parallel: the search objective and queries, with the user's key. Artificial Analysis: the user's key only                                                                                                                                                                                                                                                   | Both are off until the user stores a key. Parallel registers its tool only when the plugin is on and the key resolves; Artificial Analysis data is cached in memory for six hours.                                                                                                                                                                            |
| Custom tools and hooks                  | User-installed JavaScript modules or configured command processes                                                                                                      | Whatever the module or command is written to read or transmit                                                                                                                                                                                                                                                                                               | Custom tools always prompt before execution. Hooks and tools can run local code with the documented trust and permission boundaries; their authors control any additional network or storage behavior.                                                                                                                                                        |
| Selected personal plugin models         | An explicitly selected plugin worker inside Copse's OS sandbox; websites on exact origins declared by a browser-enabled plugin                                         | Current prompt; up to eight current-turn images (8 MB decoded total) when declared; up to 32 prior text messages / 64 KiB as a session-recovery handoff; and browser requests, typed form data, clicks, or uploaded current-turn images sent to a declared website when the plugin uses the P4 browser bridge                                               | Copse stores at most 256 KiB of JSON session state per plugin and thread. The worker has no direct network, filesystem-write, renderer, Electron, arbitrary IPC, or generic host-call authority. Browser calls operate visible plugin/thread-owned tabs in the persistent interactive `copse-browser` profile and fail closed outside exact declared origins. |

For an agent-browser screenshot, persisted tool-result text includes the handle
ID and source description, but not the pixels. The handle resolves only while
its bounded in-memory record remains live for the owning thread. A built-in
agent can explicitly call `present_visual_evidence` with one or two live handles.
That action copies the PNGs into content-addressed thread blobs and adds an
assistant-owned evidence card. The durable source URL omits credentials, query,
and fragment. Evidence is included in thread forks, JSONL exports, folder
exports, and ordinary thread deletion; it is never published automatically.

Personal plugin directories are selected explicitly and remain ordinary user
plugins. The P1–P4 runtime executes a revalidated Copse-owned snapshot in the
active macOS/Linux OS sandbox with direct network and filesystem writes denied; only tool names
and model ids declared by the manifest are available. Model input and session
flow is bounded as above. A declared browser behavior grants only the named P4
operations for exact origins in visible tabs. Because those tabs use the
interactive browser profile, a site receives that profile's cookies/storage and
the actions or attachments the plugin submits. The site's terms, authorization,
retention, automation, and acceptable-use rules still apply. User-plugin renderer
code and generic host gateways are not part of this phase.

## Provider requests

The built-in agent loop sends more than the text visible in the composer. A
request can include earlier messages, a system prompt, available tool schemas,
tool calls and results, attachments, and file contents the user or agent placed
in context. The provider credential is attached in the main process and is not
returned to the renderer.

Provider-key validation and model-list refreshes also contact the corresponding
provider endpoint. Custom OpenAI-compatible providers use the base URL and key
the user configured. LM Studio and other local endpoints are local only when the
configured address is local.

“Local” currently means loopback on this device, not another machine on the LAN. Ordinary custom
provider approval cannot authorize a provider address that names a private, link-local, single-label, or mDNS destination directly (hostnames are checked, not what they resolve to). If
Copse later adds paired LAN inference, the peer will receive the same full turn context described
above and must be presented as a separate authenticated destination with explicit revocation and
data-flow disclosure, rather than as an exception to the public provider-host allow-list.

By default Copse requests the most protective handling each provider offers at
the request level: OpenRouter traffic is restricted to zero-data-retention,
non-training upstream endpoints (two independent toggles in Settings →
Providers → OpenRouter — `openRouterZdrOnly` on and `openRouterAllowTraining`
off by default; relaxing ZDR keeps training excluded), and direct OpenAI
requests carry `store: false`. Settings → Providers badges each provider with
its default retention/training posture; see
[provider-data-policies.md](provider-data-policies.md).

Every provider request also carries two fixed app-attribution headers,
`HTTP-Referer: https://copse.dev/` and `X-Title: Copse` (OpenRouter additionally
receives `X-OpenRouter-Title: Copse`, the renamed form of the same header). They
name the application, not the user: the values are identical in every install
and are not derived from a key, account, machine, thread, or prompt. OpenRouter
treats this pair as public attribution — it is what places an app on its
rankings and app pages — while Vercel AI Gateway and Requesty use it for private
dashboard attribution and other providers ignore it.

Experimental on-device PII redaction can redact the text the user typed before a
provider, remote-agent, or ACP path receives it. It is off by default, fails open
(with a turn notice) if the redactor cannot run, and does not cover repository
files or tool output.
See [pii-redaction.md](pii-redaction.md).

## Remote execution boundaries

Copse has more than one remote execution model, and they do not have equivalent
security properties:

- **SSH workspaces** keep the UI, approval policy, model loop, and thread store local,
  but file and process operations run with the configured remote account's authority.
  With agents on the remote machine enabled, an ACP agent's own loop runs on the SSH
  host instead; Copse treats it as unsandboxed and does not offer it the native tool bridge.
  The local macOS seatbelt does not protect the SSH host. Binary files needed by local
  media and archive tools are streamed into a size-bounded, short-lived local cache;
  cache files use private permissions and are removed during orderly app shutdown.
- **Managed remote agents** hand work to Cursor or Anthropic infrastructure. Copse
  records the provider session and returned events, but the provider owns guest
  isolation, egress, credential handling, retention, and teardown. The current
  Anthropic managed-agent adapter requests an unrestricted-network cloud environment.
- **Remote e2e** is developer tooling that runs a source snapshot in a fresh container;
  it is not the product's remote-agent runtime.
- **Copse-provisioned cloud workspaces** are proposed, not shipped. Their target is a
  Copse-controlled loop and policy engine attached to disposable remote compute with
  fail-closed egress, mediated credentials, explicit lifecycle, and TTL/reconciliation
  safeguards.

The current and target guarantees are tracked in [threat-model.md](threat-model.md) and
the implementation plan in
[plans/execution-runtime-security.md](plans/execution-runtime-security.md).

## Credentials

Keys entered in Settings are stored in `settings.json` under the Copse
profile. They are encrypted with AES-256-GCM under a random data key that Copse
keeps as a single item in the operating system's keyring — the macOS Keychain,
Windows Credential Manager, or a Linux Secret Service keyring (item `Copse` /
`secret-data-key`). Keys sealed by earlier versions with Electron `safeStorage`
are still read and are rewritten in the new format the first time they are
used. If no keyring is available, Copse refuses to persist the key. The
exceptional compatibility path requires starting the process with
`COPSE_ALLOW_PLAINTEXT_SECRETS=1` and then separately consenting for each save;
that fallback is base64 plaintext, not encryption.

Keys supplied only through environment variables are not written to
`settings.json`. The opt-in environment scan reads raw values only in the main
process and exposes masked previews to the renderer. Importing a key makes it a
stored key. Provider keys are scrubbed from ordinary shell, terminal, MCP
project-config, hook, and ACP base environments; explicit tool/server/agent
configuration may pass selected values by design.

Coding plan usage is the one flow that reads credentials Copse did not store.
Without a setting or prompt of its own, it reads the Claude Code, Cursor, Codex,
and Hugging Face sign-ins described in the table above, from the macOS Keychain
(via `security find-generic-password`), those tools' credential files, Cursor's
local state database, or environment variables, and sends each token only to
its issuer's usage endpoint. The tokens are not written to Copse's settings.

## Local storage

The principal local stores are:

- `settings.json` and `config.json` under `~/.copse/user-data/` (or `COPSE_DIR`)
  for credentials, preferences, providers, projects, and UI state. Per-window UI
  state includes the Browser pane's restorable tabs, so reopening Copse brings
  the previous session back: the addresses those tabs were pointed at and the
  titles of the canvas artefacts they were showing, never page content — an
  artefact is re-read from the thread's own canvas store when its tab returns;
- `~/.copse/workspace/<projectId>/<threadId>/` (or `COPSE_WORKSPACE_DIR`) for
  conversations, reasoning, tool arguments/results, hook output, images, and
  nested subagents;
- persistent, separate browser profiles for interactive and agent-driven
  browsing under Electron user data;
- a bounded, session-only in-memory store for agent-browser screenshots and
  their thread-scoped capture handles; explicitly published captures instead
  live as content-addressed evidence blobs in the owning thread;
- `gortex/` under Electron user data for the semantic-search index;
- `~/.copse/lan/` for the Mobile Companion, once set up: its local root CA key
  and certificate, paired devices with token hashes, and its on/off preference;
- the `ssh-credentials` store for SSH passwords and passphrases the user asks
  Copse to remember, encrypted;
- model-card lookup results and coding plan usage samples in local app state; and
- `refs/copse/backups/*` inside a Git repository for a short rolling set of
  pre-turn worktree snapshots when Copse protects dirty changes.

Earlier Copse builds wrote agent-browser captures to `browser-screenshots/`
under Electron user data. This flow no longer creates those files, but an
upgrade does not automatically delete captures that already exist there.

Conversation files are integrity-hashed but are not encrypted by Copse. Disk
encryption and operating-system account permissions are the at-rest boundary.
The on-disk thread format is documented in
[thread-store-format.md](thread-store-format.md).

## Exports and support

Copse sends no analytics, crash reports, or diagnostic bundles to maintainers.
The user-triggered thread export is intentionally complete and portable, not
secret-redacted. It can contain source code and every other category stored in a
thread. Follow [../SUPPORT.md](../SUPPORT.md) before sharing one.

## Recovery and deletion

Removing a thread or local store affects only the local copy; it does not delete
data already sent to a provider, remote agent, MCP server, ACP agent, website, or
GitHub. Use that service's controls for its retained copy. Backup, migration, and
forward-recovery guidance is in [recovery.md](recovery.md).

## One person per installation, deliberately

There is no Copse account, no user directory, no sharing, and no concept of a second user.
Threads, knowledge notes, settings, and credentials belong to the operating-system user
running the app, and the access control over them is the filesystem's.

This is a **non-goal rather than an unbuilt feature**. Sharing a thread, a plan, or a note
with another person would require an identity to share with, a channel to share over, and a
retention story for whatever sits in the middle — the three things the design above exists to
avoid. [`plans/mission-control.md`](plans/mission-control.md) parks the nearest version of it
("a second person looking at someone else's run") for the same reason.

Three things that are _not_ covered by this position, because they already exist: exporting a
thread deliberately (see above), a remote execution target that the user configures and
controls, and the Mobile Companion, which gives the same user's paired phone read access and,
if granted, control over the local network. None of them introduces another principal.

Recorded here because from outside an absence and a decision look identical. Evidence:
[`plans/unowned-capability-gaps.md`](plans/unowned-capability-gaps.md) G-10.
