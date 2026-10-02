# Changelog and release notes

The canonical changelog is the set of
[GitHub Releases](https://github.com/copse-dev/copse-releases/releases). Published
release notes are owned and maintained with the GitHub Release; this file holds
only the notes in flight — `Unreleased`, and the section for the version being
released — rather than copying every published entry.

## Unreleased

- Copse reads another tool's sign-in to show plan usage only for providers you
  have set up in Settings → General: Claude Code or Codex once you have added
  and enabled its agent, Cursor once you have added its agent or saved a Cursor
  key, and Hugging Face once you have saved a Hugging Face key in Copse.
  Previously it looked for Claude Code, Codex, Cursor, and Hugging Face
  sign-ins whenever it checked plan usage, including when choosing the default
  model for a new thread. Plans that are not set up now say where to set them
  up in Settings → Usage, and nothing is read for them.
- Help → Report an Issue… opens Copse's bug report form on GitHub with your
  Copse version and Mac platform already filled in. Nothing about your
  projects, threads, or settings is included, and nothing is filed until you
  submit the form.

## 0.1.0-beta.12

This is the first published release since 0.1.0-beta.8. Betas 9, 10, and 11
were cut but never published, so their notes are included below.

- Agents connected over SSH are now treated as unsandboxed, whatever the local
  sandbox state. Shell commands in an SSH workspace, and ACP agents running on
  an SSH host, used to be judged as if the local macOS sandbox contained them,
  so some ambiguous commands could run on the remote host without a prompt.
  They now prompt, as they would anywhere else without a sandbox. Remote ACP
  agents are no longer offered Copse's local tool bridge, and the approval for
  installing an agent's adapter on the SSH host now installs a pinned version.
  Both SSH features are opt-in and stay off by default.
- Claude Sonnet 5.5 is available and is now the default model for direct
  Anthropic API keys. Claude Sonnet 5 and Sonnet 4.6 remain selectable.
- Agents on every provider can now use `apply_patch`, which adds, updates,
  deletes, and moves several files in one call. The whole patch is checked
  before anything is written. `str_replace` and `write_file` are unchanged.
- Conversations on OpenAI's Responses API keep each request a byte-stable
  prefix of the next, so automatic prompt caching applies on later turns
  instead of being invalidated.
- A message with several images opens a gallery with thumbnails, a count, and
  arrow-key navigation, from either your attachments or the agent's reply.
- The Browser pane can download an HTML canvas as one self-contained `.html`
  file.
- When a Git recovery action succeeds, such as finishing an interrupted rebase
  or "Commit and continue" after a signing failure, it runs in the background
  and the agent's turn continues automatically.
- The model picker keeps arrow keys, Enter, and Escape working while it is
  open, and typing from Recent switches to All models and starts a search.
- Escape and Enter in an open dialog act on that dialog, even while an agent is
  running, instead of stopping the agent or triggering workspace shortcuts.
- The Automations panel shows when a schedule skipped its run because its
  worktree limit was full, and edits to that limit save reliably.
- Pull requests in the PR pane link back to the thread that produced them.
- Chromium- and macOS-provided menu and dialog text in the Mac app is now in
  English for every user, matching Copse's English-only interface. This keeps
  the installed app within its size budget.

- The update prompt now lists what changed in every release since the one you
  are running, newest first, instead of only naming the new version. Skipping a
  few weekly betas no longer means missing their notes; an "All release notes"
  link opens the full history. Stable installations list stable releases only.
  If the release notes cannot be fetched, the prompt still offers the update.

- A skipped post-turn review now renders as one compact transcript annotation.
  It keeps the reason visible when a below-threshold diff or declined spend
  prompt would otherwise leave no explanation, without restoring a full review
  body. Completed and failed reviews are unchanged.

- Tool calls that miss a numeric bound no longer fail. A model that asks
  `find_files` for `max_results: 2000` against a schema capped at 200 — a
  repeated GPT-family failure — gets the call executed at the cap and a
  system-reminder note naming what was clamped, instead of a schema error and
  a retry round trip. The repair only fires when numeric range is the sole
  problem; type, enum, and missing-field errors still produce the plain
  schema error. This repair is opt-in for safe, idempotent search limits;
  mutating and third-party tools remain fail-closed. Recovered text-tool-call
  arguments (models that emit tool calls as text) get the same repair and
  adjustment note; other invalid known calls now reach the normal schema error
  instead of disappearing.

- The Browser pane now restores its tabs when Copse is reopened. A window
  remembers the pages it had open and the canvas artefacts it was showing, and
  brings them back on the next launch — a prototype the agent rendered
  yesterday is re-read from the thread it belongs to, so it reflects any edits
  made to its source in the meantime. A window that quit with the pane closed
  reopens with it closed; the tabs are simply there when it is next opened.
  Stored tabs record addresses and artefact titles, not page content.
- The renderer ↔ main API surface (`ApiClient`) is now a versioned protocol:
  a channel manifest (`schemas/api-protocol.manifest.json`) is generated from
  the contract and the preload bindings (`pnpm run gen:api-protocol`) and the
  full JSON Schema is emitted by the build, a unit test fails when the
  committed manifest drifts from the sources, and the sidecar WebSocket handshake
  exchanges `API_PROTOCOL_VERSION` and refuses a mismatched peer. The preload is
  type-checked against `ApiClient` for the first time. First step of the
  client/server split (#2312); see `docs/api-protocol.md`.
- IPC channel names now follow one convention (`namespace:method`, kebab-case
  on both halves; subscriptions drop their `on` prefix). Every channel that
  differed was renamed on both sides of the bridge, which is protocol
  version 2. Nothing outside the app spoke version 1.

- Recoverable threads in the projects sidebar are easier to deal with when a
  store no longer matters. Each row shows a recent thread title instead of only
  a count, Recover… opens a short summary before the folder picker, and Dismiss
  hides the row while leaving the chats on disk.
- Curated parameter recipes now apply by default. Qwen3.6-35B-A3B, DeepSeek
  V4 Flash, and the experimental GLM-5.3-Flash profile run on their recipe
  unless you set a value yourself. Previously they were only offered, so a
  Qwen thread on LM Studio ran with no `presence_penalty` and its reasoning
  could loop. In Settings → Models → Model parameters, blank fields show the
  recipe value they send, and anything you type replaces that one value.
- Model parameters has its own model picker and a list of the models you have
  tuned, so you can tune any model without changing your chat model. That
  matters most when the chat model is a rule such as Balanced, which has no
  parameters of its own.

## Release-note process

1. Add a user-facing entry under `Unreleased` in the PR that makes the change.
2. The version bump ([`scripts/release-bump.mts`](scripts/release-bump.mts), run
   weekly by `release-bump.yml`) renames `Unreleased` to `## <version>`, opens a
   new empty `Unreleased`, and drops the previous version's section, which its
   published GitHub Release already records. Do not rename these headings by
   hand.
3. The GitHub Release body is generated from the `## <version>` section with the
   supported OS, architectures, and update channel added
   ([`scripts/release-notes.mts`](scripts/release-notes.mts)). Before announcing
   the release, add known issues, data migrations, and recovery implications to
   it. Copse supports forward fixes only; do not recommend a downgrade. The
   in-app update prompt shows each skipped version's notes from below the
   body's `<!-- copse:changelog -->` marker, so keep that line when editing.
4. Link issues or pull requests that provide important detail without exposing
   confidential security-report information.

The complete shipping procedure is in
[docs/release-checklist.md](docs/release-checklist.md).
