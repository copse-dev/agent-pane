# Backup, migration, and recovery

Copse supports forward fixes on the latest release. Downgrading the application
or opening data modified by a newer release with an older binary is not a
supported recovery path.

## What to back up

Quit Copse before copying its data so append-only thread files and Electron
stores are not changing during the backup.

Back up together:

1. The conversation store at `~/.copse/workspace/`, or the directory selected by
   `COPSE_WORKSPACE_DIR`.
2. The Electron user-data directory:
   - macOS: `~/Library/Application Support/copse-panel/`
   - Linux source builds: `~/.config/copse-panel/`
   - Windows source builds: `%APPDATA%/copse-panel/`
3. Each project repository through its normal version-control and backup
   process. Copse's app-data backup is not a backup of the project itself.

Stored API keys are tied to the operating system's secure-storage account when
encrypted and may not decrypt after moving to another machine or user. Keep a
separate secure record of credentials and be prepared to enter them again.

Browser profiles and the semantic-search index are inside Electron user data.
They are not required to reconstruct threads; omit them only if losing browser
sessions and rebuilding the search index is acceptable.

## Worktree restore points

When Copse needs to protect dirty Git changes before an agent edit, it can create
a snapshot under `refs/copse/backups/*`. The app retains the ten newest backup
refs and exposes the current turn's restore action in the Changes pane. These
refs live in that project repository, not in Copse app data, and Git may later
garbage-collect commits after their refs are pruned. They are a short-term edit
safety net, not a substitute for commits or external backups.

## Migrations

The current thread store is versioned and documented in
[thread-store-format.md](thread-store-format.md). On first launch after the
filesystem-native store migration, Copse imports the legacy
`<userData>/threads/` tree and renames it to
`<userData>/threads.pre-copse-workspace` when possible. Existing destination
threads are not overwritten.

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
replace the conversation store and Electron user-data directory with the matched
backup copies, then launch again. Do not combine individual files from different
backup times unless the on-disk format documentation explicitly permits it.

Reinstalling the latest application bundle can repair a damaged app binary, but
it is not a data restore and does not replace the backup steps above. Thread
hash-validation failures are reported rather than silently accepted; restore
the affected complete thread directory from backup.
