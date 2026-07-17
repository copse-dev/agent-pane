# Privacy and data flow

Copse is an Electron desktop application with no Copse-hosted backend and no
product telemetry. That does **not** mean all activity is local: data is sent
directly to model providers, remote agents, MCP servers, websites, and update
infrastructure when the corresponding feature is configured or used.

This document describes the application behavior. A third-party service's own
terms, retention, logging, and training policies apply after data reaches it.

## Data-flow summary

| Feature                        | Destination                                                                                           | Data that can leave the device                                                                                                                                                                                                                                   | Local record and control                                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud and custom LLM providers | The configured provider API                                                                           | User prompts and images; conversation context; system instructions; tool definitions, arguments and results; and source or file content included in the turn                                                                                                     | Requests originate in the main process. Provider responses and tool activity are saved in the local thread. Selecting a local provider keeps this flow at its configured local endpoint.                                                                  |
| Remote agents                  | Cursor or Anthropic agent services, plus a configured GitHub repository when attached                 | Current prompt and images; on first handoff, up to 16,000 characters of prior user/assistant conversation and the current branch; repository URL/branch; and, for a repo-backed Claude Agent session, a GitHub token used by the service to mount the repository | Remote session identifiers and returned transcript/tool events are stored locally. The remote service may clone, modify, push, or open a PR for the repository according to the selected settings.                                                        |
| MCP                            | A configured local stdio process or remote HTTP server                                                | MCP tool arguments, which may contain prompt-derived text, file content, paths or other workspace data; configured environment values; and protocol metadata                                                                                                     | Tool results pass back through Copse and are stored in thread history. Project MCP configuration is workspace-trust gated; server spawn and tool use follow the MCP approval settings. The server controls its own network access and retention.          |
| ACP agents                     | A configured external agent process on the same machine; any services that process chooses to contact | Prompt text/images, the workspace path, selected MCP server configuration, and requests/results for tools exposed through the optional localhost native-tool bridge                                                                                              | Copse strips its provider secrets from the inherited base environment. Values explicitly placed in an ACP agent's `env` are still passed to it. The ACP program may have its own credentials, storage, network behavior, and privacy policy.              |
| Interactive browser            | The websites the user opens                                                                           | Ordinary browser requests, entered form data, cookies, and other site interactions                                                                                                                                                                               | Uses a persistent `copse-browser` profile isolated from the main renderer. Website storage remains on disk until the browser profile is cleared or removed.                                                                                               |
| Agent browser tools            | Approved website origins                                                                              | Browser requests and agent-entered data. Page snapshots, screenshots, and interaction results can then be sent to the selected model as tool results                                                                                                             | Uses a separate persistent `copse-browser-agent` profile, so automation does not inherit interactive-browser logins. Tool results are stored in the thread; screenshots are also written under the Copse user-data directory.                             |
| Environment-key scan           | The local main process only                                                                           | Nothing during the scan                                                                                                                                                                                                                                          | The scan runs only after the user chooses it. It reads `process.env` and a fixed allow-list of shell startup files, then sends only masked previews to the renderer. Importing a discovered key stores it under the same rules as a manually entered key. |
| Automatic updates              | GitHub Releases configured in the packaged macOS app                                                  | The normal metadata of a GitHub update request, including network address and current app/version information required by the updater                                                                                                                            | Packaged macOS builds check on launch. Copse asks before downloading; a downloaded update installs on restart or the next quit. Development builds do not check the feed.                                                                                 |
| Custom tools and hooks         | User-installed JavaScript modules or configured command processes                                     | Whatever the module or command is written to read or transmit                                                                                                                                                                                                    | Custom tools always prompt before execution. Hooks and tools can run local code with the documented trust and permission boundaries; their authors control any additional network or storage behavior.                                                    |

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

Experimental on-device PII redaction can redact the text the user typed before a
provider, remote-agent, or ACP path receives it. It is off by default, fails open
if the redactor cannot load, and does not cover repository files or tool output.
See [pii-redaction.md](pii-redaction.md).

## Credentials

Keys entered in Settings are stored in `settings.json` under the Electron
user-data directory. Electron `safeStorage` encrypts them with the macOS
Keychain, Windows DPAPI, or a supported Linux keyring when encryption is
available. If it is unavailable, Copse refuses to persist the key until the user
explicitly consents to base64 plaintext storage. Base64 is not encryption.

Keys supplied only through environment variables are not written to
`settings.json`. The opt-in environment scan reads raw values only in the main
process and exposes masked previews to the renderer. Importing a key makes it a
stored key. Provider keys are scrubbed from ordinary shell, terminal, MCP
project-config, hook, and ACP base environments; explicit tool/server/agent
configuration may pass selected values by design.

## Local storage

The principal local stores are:

- `settings.json` and `config.json` in the `copse-panel` Electron user-data
  directory for credentials, preferences, providers, projects, and UI state;
- `~/.copse/workspace/<projectId>/<threadId>/` (or `COPSE_WORKSPACE_DIR`) for
  conversations, reasoning, tool arguments/results, hook output, images, and
  nested subagents;
- persistent, separate browser profiles for interactive and agent-driven
  browsing under Electron user data;
- `browser-screenshots/` under Electron user data for agent-browser captures;
- `gortex/` under Electron user data for the semantic-search index; and
- `refs/copse/backups/*` inside a Git repository for a short rolling set of
  pre-turn worktree snapshots when Copse protects dirty changes.

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
