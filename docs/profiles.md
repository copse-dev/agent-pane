# Profiles

Everything Copse stores lives in one directory, `~/.copse/`. Back it up and you
have the whole application state; point `COPSE_DIR` somewhere else and you have a
second, independent profile.

For backup and restore procedure, see [recovery.md](recovery.md). This page
covers what a profile contains, how to run more than one, and what does **not**
travel with one.

## Layout

| Path                                                                                 | Contents                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `user-data/config.json`                                                              | Projects, active project, workspace root, pack settings, usage ledger |
| `user-data/settings.json`                                                            | Settings, including API keys                                          |
| `user-data/` (rest)                                                                  | `mcp.json`, custom tools, browser profiles, semantic-search index     |
| `workspace/`                                                                         | Threads, tasks, decision log, deferred approvals                      |
| `worktrees/`                                                                         | Copse-managed Git worktrees                                           |
| `knowledge/`, `long-tasks/`, `roadmap-review/`, `pack-tool-snapshots/`, `hooks.json` | Per-feature stores                                                    |

Project repositories are not part of a profile. A profile records _where_ your
projects are, not their contents.

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

## What profiles do not isolate: API keys

**Stored API keys are not cryptographically separated by profile.** Copse
encrypts them with Electron's `safeStorage`, which seals data with a key held by
the operating system — the login Keychain on macOS, DPAPI on Windows, and the
GNOME/KWallet secret service on Linux. That key belongs to the **OS user
account**, not to the Copse profile directory.

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

On a Linux box with no unlocked keyring, `safeStorage` is unavailable and Copse
will not silently write a key to disk in the clear: saving one requires explicit
consent, and `/checkup` warns for as long as a plaintext key is stored.

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
