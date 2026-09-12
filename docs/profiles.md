# Profiles

Everything Copse stores lives in one directory, `~/.copse/`. Back it up and you
have the whole application state; point `COPSE_DIR` somewhere else and you have a
second, independent profile.

For backup and restore procedure, see [recovery.md](recovery.md). This page
covers what a profile contains, how to run more than one, and what does **not**
travel with one.

## Layout

| Path                                                                                 | Contents                                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `user-data/config.json`                                                              | Projects, active project, workspace root, pack settings, usage ledger             |
| `user-data/settings.json`                                                            | Settings, including API keys                                                      |
| `user-data/` (rest)                                                                  | `mcp.json`, encrypted SSH authentication, browser profiles, semantic-search index |
| `workspace/`                                                                         | Threads, tasks, decision log, deferred approvals                                  |
| `worktrees/`                                                                         | Copse-managed Git worktrees                                                       |
| `knowledge/`, `long-tasks/`, `roadmap-review/`, `pack-tool-snapshots/`, `hooks.json` | Per-feature stores                                                                |

Project repositories are not part of a profile. A profile records _where_ your
projects are, not their contents.

### Development build caches

The Electron development distribution and gortex binary cache default to
`<COPSE_DIR>/cache/electron-dist/` and `<COPSE_DIR>/cache/gortex/` (or
`~/.copse/cache/` without an override). Entries remain version/platform/architecture
specific. Set `COPSE_ELECTRON_DIST_CACHE` or `COPSE_GORTEX_CACHE` to share an
explicit cache between profiles; blank values use the default.

Keep the checkout and these caches on the same drive when preparing a portable
development installation. New cache symlinks are relative, so moving both with
their directory layout intact preserves the links, including mount names with
spaces. Run `pnpm install` or `pnpm start` during preparation to replace old
absolute Electron links; `node scripts/fetch-gortex.mts` replaces gortex links.
A populated matching cache can be reused without downloading. Missing cache
contents still require preparation online; this is not an offline installer.

These caches are disposable build artifacts. The package-manager store, downloaded
archives, native rebuild tools, experimental Tauri shell cache and local models
have their own locations and are not relocated by this change.

## Running more than one profile

Set `COPSE_DIR` before launching:

```bash
COPSE_DIR=~/copse-work /Applications/Copse.app/Contents/MacOS/Copse
```

Each profile gets its own projects, threads, settings, worktrees and browser
sessions. Nothing is shared between them on disk.

Three narrower overrides move one directory each, and take precedence over
`COPSE_DIR`. They exist for tests and unusual deployments; prefer `COPSE_DIR`:

| Variable                | Moves                                    |
| ----------------------- | ---------------------------------------- |
| `COPSE_PANEL_USER_DATA` | `user-data/` (Electron profile data)     |
| `COPSE_WORKSPACE_DIR`   | `workspace/` (the thread and task store) |
| `COPSE_WORKTREES_DIR`   | `worktrees/`                             |

If you set any of them, that directory is no longer inside `COPSE_DIR` and needs
backing up separately.

## Launching with a prepared toolchain

Set `COPSE_PRESERVE_PATH=1` when a launcher supplies a complete `PATH`:

```bash
export COPSE_DIR="/Volumes/Dev Disk/CopseKit/data/copse"
export COPSE_PANEL_USER_DATA="$COPSE_DIR/user-data"
export COPSE_PRESERVE_PATH=1
export PATH="/Volumes/Dev Disk/CopseKit/toolchains/macos-arm64/bin:/usr/bin:/bin:/usr/sbin:/sbin"
make run
```

Run this from the prepared Copse checkout. Its toolchain directory must already
contain the compatible Node and pnpm executables and other required development
tools. `COPSE_PANEL_USER_DATA` skips migration of a host's legacy profile.

With this opt-in, Copse leaves the launcher's PATH intact, its tool-availability
probes use that PATH without adding system prefixes, and `make run`/`make run-dev`
do not activate host nvm. Without `COPSE_PRESERVE_PATH=1`, launch behavior stays
unchanged. This option supplies no default tools: a missing or incomplete PATH
can cause startup or tool checks to fail.

This is control over PATH, not a complete portable or offline mode. Shell startup
files, explicit executable paths, MCP/skill discovery, model runtimes, credential
helpers and binary dependencies still need preparation. `make run` can still
install dependencies or build missing outputs. HOME, secret filtering and sandbox
policy are unchanged. See the [drive portability audit](plans/drive-portability-audit.md)
for the remaining work beyond #2652.

## What profiles do not isolate: encrypted credentials

**Stored API keys and remembered SSH authentication are not cryptographically
separated by profile.** Copse encrypts them under a data key it keeps in the
operating system's keyring — the login Keychain on macOS, Credential Manager on
Windows, and the GNOME/KWallet secret service on Linux (one item, `Copse` /
`secret-data-key`; keys stored by earlier versions through Electron's
`safeStorage` are migrated on first use).
That key belongs to the **OS user account**, not to the Copse profile directory.

Two consequences:

- **On one machine, every profile shares one encryption key.** Separate profiles
  keep keys in separate files, so one profile cannot read another's
  `settings.json` by accident. But the separation is filesystem-level, not
  cryptographic: anything running as your OS user that can read the file can
  decrypt it. Do not treat a second profile as a security boundary for
  credentials.
- **Keys do not survive a move to another machine or OS user.** The ciphertext
  copies fine; the key that opens it does not. After restoring a profile
  elsewhere, every stored key is unreadable and must be re-entered.

Run `/checkup` after restoring a profile. A key that cannot be decrypted is
reported as an error against the provider it belongs to. Re-enter it in
**Settings → Providers**, or supply it through the provider's environment
variable, which bypasses stored keys entirely and is the better option for a
profile you intend to move between machines.

On a Linux box with no unlocked keyring, encryption is unavailable and Copse
will not silently write a key to disk in the clear: saving one requires explicit
consent, and `/checkup` warns for as long as a plaintext key is stored.

API keys, remembered SSH passwords/key passphrases, and remembered VNC logins
are the secrets Copse itself encrypts. SSH authentication is scoped to a
configured host and can be forgotten from **Settings → SSH**; removing a host
forgets its authentication too. VNC logins are scoped to the selected machine,
are stored only after successful authentication, and can be removed with
**Forget saved login** in the Desktop pane. Everything else in the profile is
plain JSON or plain files — but "not encrypted" is not the same as "portable",
because several stores record **absolute paths**.

## Moving a profile to another machine

Threads are the part that always survives. They are keyed by the project's
internal id, not by where the repository sits, so `workspace/` restores intact
even if every path changed.

What needs attention:

| Store                                 | On a path change                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Threads, tasks, decision log          | Survive — keyed by project id                                                                                 |
| Knowledge, long tasks, roadmap review | Survive — keyed by project id                                                                                 |
| Projects (`config.json`)              | Record absolute paths. A path that no longer exists is quarantined, not deleted; relocate it from the sidebar |
| Worktrees                             | Git records absolute paths inside each linked checkout; expect to recreate them                               |
| Browser sessions                      | Cookies are sealed with the same OS key as API keys, so logins do not survive                                 |
| Semantic-search index                 | Rebuilt on demand                                                                                             |

So the practical restore sequence is: copy `~/.copse/` across, relocate each
project onto its path on the new machine, and re-enter your API keys. Threads
and per-project notes follow the project once it is relocated; browser logins
and the search index rebuild themselves.

## Other things that do not travel

- **Browser sessions and the semantic index** live in `user-data/` and are the
  bulk of its size. Both are rebuildable — omitting them keeps a backup small at
  the cost of re-logging-in and re-indexing.
- **Worktree restore points** (`refs/copse/backups/*`) live in each project's own
  Git repository, not in the profile.

## Migrating a profile from before the single-root layout

Copse used to split its state across two directories: `~/.copse/` for threads,
worktrees and knowledge, and Electron's own user-data directory for everything
else —

- macOS: `~/Library/Application Support/copse-panel/`
- Linux: `~/.config/copse-panel/`
- Windows: `%APPDATA%\copse-panel\`

The first launch after updating moves that directory to `~/.copse/user-data/`.
It is automatic, happens once, and needs no action.

If the move cannot complete, Copse logs the reason at startup and **keeps using
the old directory**, so no data is lost and it retries on the next launch. The
cases it will not force:

| Situation                                       | What happens                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Both old and new directories hold data          | The new one is used; the old is left untouched for you to reconcile or delete                 |
| `COPSE_DIR` is on a different volume            | The profile is copied, and the original is left beside it with a `.migrated` suffix to delete |
| Something that is not a directory is in the way | Nothing is deleted; the old directory stays in use                                            |
| `COPSE_PANEL_USER_DATA` is set                  | Skipped entirely — that variable means "use exactly this directory"                           |

Until a launch has completed the move, back up both locations. Afterwards,
`~/.copse/` is the only one that matters.
