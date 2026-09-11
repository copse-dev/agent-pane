# Portable development environment (Apple Silicon preview)

The Copse repository owns the setup recipe and can develop itself using that
recipe. Installed software and local state live in an ignored `.portable/`
directory inside the checkout:

```text
/Volumes/RemoteWork/debugging/agent-panel/
  .git/                      # independent clone, not a linked worktree
  src/
  scripts/portable/          # tracked installer, version pins and package lock
  .portable/
    apps/darwin-arm64/        # Node, Corepack, Claude, Codex, ripgrep, ACP adapters
    projects/                # other independent clones, or another Copse checkout
    models/                  # reserved; setup does not download model weights
    cache/                   # pnpm, npm, Corepack, Electron and gortex
    data/                    # fresh Copse and agent profiles
    tmp/
    portable-dev
    Open Dev Shell.command
    Launch Copse.command
```

Git, lint and Copse's search indexer exclude `.portable/`. The build and unit-test
entry points operate on the source directories. Open a nested project as its own
Copse project when working on it. Additional Copse clones can use the outer
checkout's development shell; they do not need another tool installation.

## Prepare

Use an APFS drive with Unix permissions and symlinks. Both machines must be
Apple Silicon Macs, with Apple's Command Line Tools or Xcode selected and
`xcrun`, Git, make and `/usr/bin/python3` working. This preview does not install
Apple's SDK, Git or Python, and does not support Intel or Linux.

Clone Copse normally, then run from the checkout:

```bash
make portable-setup
make portable-shell
make portable-run
```

A linked Git worktree or `git clone --shared` still depends on a different disk
and is not suitable for the primary clone. For a separate environment root,
place Copse under `ROOT/projects/agent-panel` and pass `PORTABLE_ROOT=ROOT` to the
Make targets. The default needs no absolute path configuration.

Setup uses macOS's Bash, curl, tar and SHA-256 tools to bootstrap Node. Node and
Claude downloads have reviewed checksums in `scripts/portable/versions.sh`.
Node must match `.nvmrc`; pnpm must match `packageManager`. A separate npm lock
pins the adapters and all transitive dependencies. Corepack installs the pinned
pnpm into the drive cache; Copse uses its normal frozen pnpm lockfile and
`make build`. Ripgrep comes from the locked Codex platform package. No Homebrew
or global npm installation is needed.

Setup creates fresh state, preserves existing profile files, and can be repeated
to repair tools. Stop running portable processes first: `npm ci` replaces the
tools package directory. A mkdir lock prevents simultaneous setup processes.
After an unclean interruption, remove `.portable-setup-lock` only after checking
that setup has stopped.

## Develop and move

```bash
.portable/portable-dev doctor
.portable/portable-dev exec claude
.portable/portable-dev exec codex login
.portable/portable-dev prepare
```

The development shell selects drive-local tools and caches without loading host
shell rc files. It retains the real user home. `exec` runs a command in the same
environment. Other projects can be opened from this shell normally. Do not point
global npm/pnpm configuration at a removable disk.

Launchers derive the root from their own location. After moving the checkout or
changing the mount path, run `prepare` online: it invalidates the dependency
fingerprint so pnpm rebuilds absolute metadata and generated commands. `run`
refuses an unprepared/moved checkout and starts the existing build; it does not
silently remove dependencies or attempt an offline rebuild. After source or
dependency edits, explicitly run `prepare` (or `make build` in the portable shell).
Quit Copse, agents and development shells before ejecting. Never use one profile
concurrently on two machines.

`.portable/data` is persistent user data even though Git ignores it. Preserve
`.portable/` when cleaning a checkout: for example, use
`git clean -fdx -e .portable/` rather than deleting every ignored file. Back up
profiles separately from the reproducible tool installation.

Copse's launcher PATH support in PR #2657 is required for launching with the
selected tools; the launcher reports its absence. PR #2656 makes the shared
Electron/gortex cache symlinks relative; include it before testing relocation.
These changes are independent of the encryption plan in #2652.

## Boundaries

This is a reproducible tool installation and development build, not a complete
offline workstation image. Apple's SDK, OS permissions, Keychain and system
utilities remain host dependencies. Electron rebuild currently also writes
headers under the host `~/.electron-gyp`; its internal path overrides node-gyp's
configured cache. Further work is needed to relocate this upstream cache.

Claude's launcher disables updates so its pinned version stays selected. Codex's
wrapper selects `data/codex` only for the child process. Fresh Codex profiles use
the OS keychain. Claude uses its configured directory and normally the Mac
keychain; credentials can fall back to a file when keychain writes fail. Sign in
separately on each Mac. Setup never imports host secrets. Profile relocation does
not implement portable secret encryption. Copse ACP sandbox access to relocated
agent state still needs end-to-end validation.

Cloud inference requires a connection. Local model runtimes/weights, desktop
Claude/Codex apps, project-specific tools, guaranteed offline reinstalls and a
second-Mac acceptance run are not included in this preview. pnpm fetch alone
does not prefetch all lifecycle-script downloads. `doctor` reports prerequisites
and selected executable paths; it does not certify those broader checks.

To update tools, review `versions.sh` and `tools/package.json`, regenerate
`tools/package-lock.json` with the pinned Node's npm, then rerun setup and the
relocation checks. Do not replace pins with `latest` in the setup script.
