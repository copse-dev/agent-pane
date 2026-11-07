# Changelog and release notes

The canonical changelog is the set of
[GitHub Releases](https://github.com/copse-dev/copse-releases/releases). Published
release notes are owned and maintained with the GitHub Release; this file holds
only the notes in flight — `Unreleased`, and the section for the version being
released — rather than copying every published entry.

## Unreleased

- Screen readers now announce the Settings dialog by name when it opens.

## 0.1.0-beta.16

- Copse no longer decodes Brotli-compressed HTTP responses itself, closing
  CVE-2026-111497, a remote code execution flaw in the Brotli decoder of the
  Node.js that Electron bundles. Copse now asks servers for gzip instead, and a
  server that sends Brotli anyway fails that request. The guard lifts itself
  once Copse ships an Electron with a fixed Node. Thread containers now start
  from Node 24.22.1, which has the fix.
- Package installs no longer need a third-party tool installed first, so there
  is nothing extra to approve before an install, and updating a coding-agent
  adapter that is already installed no longer asks. A package that public
  malware lists flag is refused when it is downloaded.
- Package installs an agent runs no longer pick up versions published to npm,
  PyPI or crates.io in the last 48 hours; they install the newest older version
  instead, and say which packages had newer versions left out. Installs from a
  lockfile, and installs you run yourself in a terminal, are unaffected.

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
