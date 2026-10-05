# Changelog and release notes

The canonical changelog is the set of
[GitHub Releases](https://github.com/copse-dev/copse-releases/releases). Published
release notes are owned and maintained with the GitHub Release; this file holds
only the notes in flight — `Unreleased`, and the section for the version being
released — rather than copying every published entry.

## Unreleased

## 0.1.0-beta.14

- Settings → About has an update channel. Beta gets new features first; switch
  to Stable and Copse keeps installing betas until the next stable release,
  then installs only stable releases. It never moves you back to an older
  version. Copse remembers the channel you installed from, so beta testers stay
  on beta after the first stable release unless they choose Stable.
- The footer's context ring no longer drops to about 0% when a run starts and
  then jumps back up after the first model call: its first reading now counts
  the system prompt and tools, as the readings that follow do. Its label also
  quotes the same figures as the hover beside it. The hover's Subagents line
  now says "N running" for runs still going and "no usage reported" or "N
  without usage" for runs that ended without reporting tokens, instead of
  "no usage yet" beside a run already marked done.

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
