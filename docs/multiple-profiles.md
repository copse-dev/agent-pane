# Running multiple Copse profiles

Copse normally allows one running instance for its default profile. Give each
additional instance its own profile directories to run two or more instances at
the same time. An unused set of directories starts with the first-run setup;
reuse the same paths later to reopen that profile.

## Packaged app on macOS

Keep the normal Copse instance open, then run this in Terminal to open a second,
fresh profile:

```bash
open -n -a "/Applications/Copse.app" \
  --env "COPSE_DIR=$HOME/.copse/profiles/secondary"
```

`open -n` asks macOS to start another app process. `COPSE_DIR` gives it a
complete, separate Copse profile, including its own single-instance lock. If
Copse is installed somewhere else, replace `/Applications/Copse.app` with its
app path.

Choose a different profile name in place of `secondary` for every additional
profile. The name is only a directory name; Copse creates the profile and its
subdirectories on first use. Reuse the same path later to reopen that profile.

## Source build

Prefix the usual `make run` command with the profile root:

```bash
COPSE_DIR="$HOME/.copse/profiles/secondary" \
make run
```

`make run` still installs dependencies and rebuilds when needed; the environment
variable is inherited by the launched Copse process. One terminal can run
`make run` for the default profile while another runs the command above for the
secondary profile.

## What a profile isolates

`COPSE_DIR` contains the complete Copse-owned profile:

- `user-data/` stores settings, provider credentials, projects, UI state,
  browser data, and the search index.
- `workspace/` stores conversation threads, messages, attachments, tool
  history, and background tasks.
- `worktrees/` stores Copse-managed Git worktrees.
- Other profile-level data includes knowledge, long-running task state, roadmap
  review checkpoints, sandbox scratch files, and user-level Copse hooks.

The older granular overrides—`COPSE_PANEL_USER_DATA`, `COPSE_WORKSPACE_DIR`, and
`COPSE_WORKTREES_DIR`—remain available for tests and unusual storage layouts.
Each takes precedence over its corresponding path beneath `COPSE_DIR`, but most
users should set only `COPSE_DIR`.

Profiles still run as the same operating-system user. They can open the same
repositories and can see the same shell environment, user-level configuration,
and operating-system credential store. Avoid asking both instances to edit the
same checkout at the same time. Provider credentials saved through Copse must be
configured separately in each fresh profile.

To discard a profile, quit its Copse instance and move that profile's directory
(for example `~/.copse/profiles/secondary/`) to the Trash. This removes that
profile's Copse settings, conversations, browser state, search index, and
managed worktrees; it does not delete the project repositories you opened in
Copse. The profile remains recoverable until the Trash is emptied.
