# Changelog and release notes

The canonical changelog is the set of
[GitHub Releases](https://github.com/copse-dev/copse-releases/releases). Published
release notes are owned and maintained with the GitHub Release; this file holds
only the notes in flight — `Unreleased`, and the section for the version being
released — rather than copying every published entry.

## Unreleased

- Recoverable threads in the projects sidebar are easier to deal with when a
  store no longer matters. Each row shows a recent thread title instead of only
  a count, Recover… opens a short summary before the folder picker, and Dismiss
  hides the row while leaving the chats on disk.

## 0.1.0-beta.10

- The update prompt now lists what changed in every release since the one you
  are running, newest first, instead of only naming the new version. Skipping a
  few weekly betas no longer means missing their notes; an "All release notes"
  link opens the full history. Stable installations list stable releases only.
  If the release notes cannot be fetched, the prompt still offers the update.

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
