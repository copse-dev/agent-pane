# Backup, migration, and recovery

Copse supports forward fixes on the latest release. Downgrading the application
or opening data modified by a newer release with an older binary is not a
supported recovery path.

## What to back up

Quit Copse before copying its data so append-only thread files and Electron
stores are not changing during the backup.

Back up **`~/.copse/`** — or the directory `COPSE_DIR` selects. That single root
holds the whole profile:

| Path                                                                                 | Contents                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `user-data/config.json`                                                              | Projects, active project, workspace root, pack settings, usage ledger |
| `user-data/settings.json`                                                            | Settings, including encrypted API keys                                |
| `user-data/` (rest)                                                                  | `mcp.json`, custom tools, browser profiles, the semantic-search index |
| `workspace/`                                                                         | Conversation store: threads, tasks, decision log, deferred approvals  |
| `worktrees/`                                                                         | Copse-managed Git worktrees                                           |
| `knowledge/`, `long-tasks/`, `roadmap-review/`, `pack-tool-snapshots/`, `hooks.json` | Per-feature stores                                                    |

Back up each project repository separately, through its normal version-control
and backup process. Copse's app-data backup is not a backup of the project
itself.

Stored API keys are sealed with the operating system's secure storage, which
belongs to the OS user account rather than to the Copse profile, so they do not
decrypt after a restore onto another machine or user. Keep a separate secure
record of credentials and expect to enter them again; `/checkup` reports each
key it cannot decrypt. See [profiles.md](profiles.md#what-profiles-do-not-isolate-api-keys).

Browser profiles and the semantic-search index are the bulk of `user-data/` and
are not required to reconstruct threads. Excluding them keeps a backup small, at
the cost of losing browser sessions and rebuilding the search index on restore.

The granular overrides `COPSE_WORKSPACE_DIR`, `COPSE_WORKTREES_DIR`, and
`COPSE_PANEL_USER_DATA` each move one directory out of this root. If you set
any of them, back up that location too. See [profiles.md](profiles.md) for
running more than one profile and for what a profile does not carry with it.

### Profiles from before the single-root layout

Copse used to keep Electron user data outside `~/.copse`, in
`~/Library/Application Support/copse-panel/` (macOS),
`~/.config/copse-panel/` (Linux), or `%APPDATA%/copse-panel/` (Windows). The
first launch after updating moves that directory to `~/.copse/user-data/`. If
the move cannot complete — an unwritable data root, or a profile already there —
Copse logs the reason at startup and keeps using the old directory, so back up
both locations until a launch has moved it.

When `COPSE_DIR` points at a different volume from the old profile, the
directory is copied rather than moved and the original is left beside it with a
`.migrated` suffix. Delete it once the new profile is verified.

## Worktree restore points

When Copse needs to protect dirty Git changes before an agent edit, it can create
a snapshot under `refs/copse/backups/*`. The app retains the ten newest backup
refs and exposes the current turn's restore action in the Changes pane. These
refs live in that project repository, not in Copse app data, and Git may later
garbage-collect commits after their refs are pruned. They are a short-term edit
safety net, not a substitute for commits or external backups.

## Migrations

The current thread store is versioned and documented in
[thread-store-format.md](thread-store-format.md). The one-time import of the
pre-#644 `<userData>/threads/` tree has been removed: a profile that never ran
it keeps that directory untouched on disk, and its threads are not carried
forward. Nothing is deleted, so the JSON files remain readable and can be
imported by hand if they are still wanted. A profile that already migrated has
its archived copy at `<userData>/threads.pre-copse-workspace`.

Before installing a release that announces a data migration:

1. Quit the current release and take the complete backup above.
2. Read the GitHub Release notes for migration and known-issue details.
3. Install the new release and let it complete startup before changing copied
   backup data.
4. Verify projects, settings, and representative threads before resuming work.

Migrations are forward-only. Keep the pre-update backup unchanged until the new
release has been verified.

## Recovering from an update or damaged local data

If an update is known to be bad, do not downgrade. Quit Copse, preserve the
current data directories for investigation, and report the problem through
[../SUPPORT.md](../SUPPORT.md). Recovery is a corrective newer release.

To restore a pre-update backup, install the latest supported release, quit it,
replace `~/.copse/` with the backup copy, then launch again. Do not combine individual files from different
backup times unless the on-disk format documentation explicitly permits it.

Reinstalling the latest application bundle can repair a damaged app binary, but
it is not a data restore and does not replace the backup steps above. Thread
hash-validation failures are reported rather than silently accepted; restore
the affected complete thread directory from backup.
