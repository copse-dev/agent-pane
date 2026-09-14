# Drive portability audit beyond #2652

Audit base: `f5f1764c2` on `origin/main`, 11 September 2026. Scope: one
external-drive development kit used sequentially on compatible Macs, following
[PR #2652](https://github.com/copse-dev/agent-pane/pull/2652). That PR is a
documentation proposal; its encryption, launchers and portability acceptance
gates are not implemented by opening it. This audit leaves encryption to that
work and identifies independently reviewable implementation slices.

## Already present

- `packages/store-kit/src/copse-paths.ts` centralizes profile, user-data,
  workspace, worktree and scratch paths under `COPSE_DIR`, with granular overrides.
- Threads and per-project stores use stable IDs; moving the root does not require
  rewriting transcript text. Project repositories themselves are separate data.
- `src/main/app-init.ts` resolves Electron user data before constructing stores.
  Set both `COPSE_DIR` and `COPSE_PANEL_USER_DATA` for a prepared kit: the latter
  bypasses automatic migration of a host's legacy profile.
- Local provider routes already exist. A new model-provider protocol is not
  required to use a disk-hosted local model server.

## Implemented independently

### Build-cache relocation

The cache PR makes `scripts/patch-dev-name.mts` and `scripts/fetch-gortex.mts`
derive their default caches from `COPSE_DIR`, while retaining dedicated cache
overrides. Relative links allow a checkout and its cache to move together.
Canonical parent paths handle macOS path aliases; dangling Electron links are
recognized with `lstat`, and gortex links can be repaired from a populated cache.
Tests move an actual directory tree and run the gortex installer against a local
fixture cache without a download.

This does not relocate pnpm/Corepack/download caches, provide missing binaries,
or make a host-linked Git worktree an independent repository. It does not depend
on the launch-PATH PR or encryption.

### Preserve the launcher's tool selection

The launch-PATH PR adds the supported `COPSE_PRESERVE_PATH=1` opt-in: Electron
does not augment the supplied PATH, availability probes do not prepend host
paths, and Make does not activate host nvm. Ordinary launches retain their
existing behavior. A kit launcher must supply its own complete PATH, including
the system commands it needs. This does not replace `HOME` or relax sandbox or
credential filtering rules.

The scope is deterministic PATH handling at these entry points. An interactive
shell, external agent, MCP configuration, hardcoded executable or an executable's
own dependencies can still refer to the host. No UI/layout change is involved.

## Remaining PRs, in dependency order

| Proposed PR                                           | Current evidence / problem                                                                                                                                                                                                                                                                                                              | Acceptance gate                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable-kit manifest, inventory and launch preflight | No kit manifest or launcher exists. `package.json` releases are OS/architecture specific and macOS requires 26.0. `Makefile`, `scripts/sync-dev.mts`, postinstall scripts and native modules require supporting tools. Experimental `scripts/tauri-shell.mts` has its own home-rooted cache.                                            | A read-only report inventories app/tool/model versions, resolved executable/library/symlink paths, free space, granular overrides and paths outside the kit. Missing disk/profile/tools stop launch before creating stores or downloading anything. Both Macs pass from a clean launch environment.                                                                                                                             |
| Structured project relocation and Git repair          | Projects persist absolute paths (`src/shared/types/state.ts`). Worktree operations resolve Git's administrative directories (`src/main/services/worktree-manager.ts`); a Copse profile alone does not contain each project's Git objects. This investigation checkout itself is a linked worktree with its admin directory on the host. | Move the kit to a different mount path containing spaces; retain project/thread IDs, current edits and active checkout associations. Check `.git`, `commondir`, submodule links and object alternates. Use independent clones and repair linked worktrees; do not replace strings in historical chat. Back up and validate a structured migration before writing.                                                               |
| Controlled integration and child-process environment  | `src/main/services/mcp/mcp-registry.ts` reads host `.cursor/mcp.json`; skill/plugin discovery and Cursor/Claude adapters consult host homes. Terminal startup inherits `SHELL` and shell configuration. `Makefile` and app startup are only two of the environment entry points.                                                        | Prepared local MCP/skills/plugins and shell tools run on both Macs with host profiles absent. Disable automatic package downloads; isolate configuration/cache paths per tool. Preserve provider-secret stripping in `child-process-env.ts` and existing shell permissions. Hook changes must follow the binding hooks/feature-packs plan.                                                                                      |
| Local-only operation policy                           | `resolve-agent-model.ts` can fall back to cloud models; `small-tasks-provider.ts` can fall back to the chat model. Update checks, model catalogs, external agents, web integrations and downloads are independent network users.                                                                                                        | Explicitly route every enabled role locally; prevent cloud fallback and defer external refresh/download work while retaining localhost models, MCP and previews. Complete a real edit/test task with external networking disabled, including review and title generation.                                                                                                                                                       |
| Profile writer guard and owned-service shutdown       | `src/main/index.ts` uses Electron's local single-instance lock and bypasses it for ACP. Gortex PID validation in `semantic-index.ts` checks that a process command names gortex, not that it belongs to this profile/host/boot. Shutdown cleanup exists but is not an eject protocol.                                                   | Concurrent writers are rejected across supported entry points. A PID copied from Mac A must never authorize signaling an unrelated gortex on Mac B. Bind owned services to profile and process identity, recover stale locks carefully, flush writes and stop owned processes before reporting safe shutdown. Test interruption, unplug/reconnect and failed flush without overwriting state.                                   |
| Pinned offline toolchain/model bundle and updates     | `COPSE_DIR` is profile relocation, not a software distribution. `make run` may install/build; native dependencies, Git helpers, browser binaries, model runtimes, compiler/SDK inputs and package caches are separate. Browser sessions also have OS-bound storage outside Copse's application cipher.                                  | Prepare artifacts online, then cold-start packaged Copse and `make run` offline on both Macs. Execute Git/worktree, PTY, search, browser and real model/tool tasks. Restore dependencies and rebuild native modules offline in a disposable checkout. Audit non-system libraries and absolute shebangs. Verify forward recovery from an interrupted update; browser authentication needs its own explicit portability decision. |

The manifest/preflight and process-ownership work can start without encryption.
Project relocation and integration policy also have independent code boundaries,
but need migrations or behavioral decisions beyond a small path fix. The full
launcher should compose those contracts rather than claim the two implemented
changes establish a portable environment.

## Validation and limits

The implementation PRs carry their own check results. No external drive was
modified, no user profile was migrated, and no credentials were copied during
this audit. No two-Mac/offline/native-runtime acceptance is claimed.

The final release gate remains the sequential rehearsal in #2652: cold-start
both packaged and development builds offline on each Mac, perform a real coding
task, stop/flush/eject, change the mount point, continue the same project/thread
on the second Mac, then return to the first. Preserve an independent backup.
