---
title: 'Privacy Policy — Copse'
description: 'How Copse keeps project data local and what is shared when you connect external services.'
canonical: https://copse.dev/privacy.html
generated_from: site/privacy.html
---

<!-- Generated from site/privacy.html by scripts/sync-site-markdown.mts.
     Do not edit by hand — edit the page and run `npm run site:md`. -->

Privacy by architecture

# Privacy Policy

Your workspace stays yours. Here’s exactly where Copse keeps data and when it leaves your machine.

Last updated: July 2026

**Copse has no hosted backend and sends no product telemetry.** Data stays on your machine until you configure or use a feature that talks directly to another service, such as a cloud model, remote agent, MCP server, website, or the GitHub update feed.

## The Short Version

- **No Copse account or backend.** The desktop app talks directly to services you configure; Copse does not operate an intermediary service for your prompts or code.
- **No telemetry.** No analytics, no crash reporting, no usage data collection. Maintainers do not automatically receive diagnostics.
- **External features send data.** Cloud models, remote agents, MCP/ACP, browser sessions, custom tools, hooks, and updates have the data flows described below.
- **Local does not mean encrypted.** Conversations are stored as ordinary files. API keys use OS secure storage when available; otherwise plaintext storage requires explicit consent.

## Data Sent to Services You Choose

### Model providers

A cloud model request can include your prompt and images, earlier conversation, system instructions, tool definitions, tool calls and results, and source or file content included in context. Requests go directly from the app's main process to the configured provider. Local providers remain local only when their configured endpoint is local.

Provider-key validation and model-list refreshes also contact the provider. The provider's privacy, retention, logging, and training policies apply after it receives the data.

### Remote agents

Selecting a Cursor or Anthropic remote agent sends the current prompt and images. The first handoff can also include prior user/assistant conversation and the current Git branch. A repo-backed session sends the repository URL and branch so the service can clone or mount the project; Claude's repo-backed flow also sends the configured GitHub token to the service for that mount. The remote service may modify a branch or open a pull request according to the selected settings.

### MCP and ACP

MCP servers receive tool arguments, which may contain paths, file content, prompt-derived text, or other workspace data. Results return through Copse and are stored in the thread. An MCP server can be a local process or remote HTTP service and controls its own networking, logs, and retention. Project MCP configuration is workspace-trust gated; server and tool approvals apply according to your settings.

An ACP agent is an external program running on the same machine. Copse gives it the prompt, workspace path, selected MCP configuration, and any tools exposed through the optional localhost bridge. Copse strips its provider keys from the inherited base environment, but values explicitly configured for the agent are passed to it. The ACP program may have its own credentials, storage, and network behavior.

### Browser and web tools

Websites opened in Copse receive normal browser requests and any data entered into them. The interactive browser and agent automation use separate persistent profiles, so the agent does not inherit the user's interactive logins. Agent snapshots, screenshots, and interaction results may be sent to the selected model as tool results and are stored in the thread. Browser cookies and site storage remain in their local profiles.

### Custom tools and hooks

User-installed custom tools and configured hooks run code on the device and can read or transmit whatever their implementation and permissions allow. Review them as code, not as passive configuration.

### Updates

The packaged macOS app checks its GitHub Releases update feed on launch. Copse asks before downloading an update. Once downloaded, the update installs when you restart or next quit. Development builds do not use the feed.

## Credentials and Environment Scanning

Keys entered in Settings are written to `settings.json`. Electron secure storage encrypts them with the OS account's key store when available. If it is unavailable, Copse refuses to persist the key until you explicitly approve base64 plaintext storage. Base64 is recoverable by anyone who can read the file.

Environment-only keys are not written to `settings.json`. The environment-key scan runs only when you choose it. It reads `process.env` and a fixed allow-list of shell startup files in the main process and shows the renderer only masked previews. Importing a detected key turns it into a stored key.

## Local Storage

Copse stores data locally, including:

- settings, credentials, provider configuration, projects, and UI preferences;
- conversation messages, reasoning, tool calls/results, images, hooks, and subagents;
- separate browser profiles and agent-browser screenshots;
- semantic-search indexes; and
- short-lived Git worktree backup refs inside opened repositories.

Conversations are integrity-hashed but are not encrypted by Copse. Disk encryption and OS account permissions protect them at rest. Deleting a local record does not delete copies already retained by an external provider, agent, server, or website.

## Telemetry, Exports, and Diagnostics

Copse includes no product analytics, crash reporter, or automatic diagnostic upload. The built-in thread export is deliberately complete, not secret-redacted: it can include prompts, source code, paths, attachments, tool data, reasoning, and nested agent transcripts. Inspect and redact a copy before sharing it through GitHub or email. Never share settings, environment dumps, shell startup files, or browser profiles.

## Contact

For privacy questions, ordinary bugs, and suspected vulnerabilities, write to [security@copse.dev](mailto:security@copse.dev) without including sensitive data.
