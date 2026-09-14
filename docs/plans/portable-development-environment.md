# Fully portable Copse development environment

Status: proposed plan, 2026-09-11. No software or user data has been migrated.

The detailed credential design is now in
[Device-bound profile encryption](device-bound-profile-encryption.md). It uses
Touch ID/system authentication, a profile-key envelope for each enrolled Mac,
and a random recovery key kept in the password manager. It preserves ad-hoc
`make run` against the real profile. That document supersedes earlier suggestions
to make a passphrase-protected key store the default.

Revalidated against freshly fetched `origin/main` at `f5f1764c2`. The initial
draft inspected an older checkout: latest main already provides `COPSE_DIR`
and a shell-neutral secret cipher. The remaining work below reflects those
existing implementations rather than proposing replacements for them.

Validation: 29 existing tests passed across `copse-paths`, `keyring-cipher` and
`user-data-migration`, run directly with Node's test runner because this worktree
has no installed pnpm/dependency tree. This validates the path/cipher primitives;
it is not an OS-keyring integration test or the two-laptop offline rehearsal.

## Objective and assumptions

Make Copse, its development checkout, supporting software, local models and
working state a complete, relocatable environment on an external drive. Moving
that drive between compatible computers must preserve the workflow without a
host-installed development environment. Offline operation is a standing
capability, not a temporary deployment mode; online services remain optional.

Start with supported macOS machines and use the two laptops as the initial
validation pair. Document the compatibility requirements for additional machines
and provide platform/architecture-specific bundles where needed. Portability
includes repeatable setup, upgrades, dependency restoration, native rebuilding,
device enrollment and recovery over the lifetime of the environment.

The current machine is macOS on arm64. A directly attached APFS volume named
`Remote work` is mounted. Confirm this is the intended disk, its capacity and
connection, and both laptops' OS versions, CPU architectures and RAM before
choosing binaries and models. The current Copse package declares macOS 26.0 as
its minimum version. Neither disk capacity nor the second laptop was verified.

The achievable boundary is **no host-installed development dependencies**.
The running OS, system frameworks, GPU drivers, hardware memory and macOS access
permissions remain host dependencies. OS-managed swap, logs and some temporary
state may still touch the internal disk. This is not a promise of zero host writes.

Supporting software must also live on the drive. This includes tools needed to
rebuild native dependencies, rather than relying only on a prepared `node_modules`.
Any tool that cannot satisfy this must be reported as an exception before the
environment is declared complete.

Full native dependency rebuilding is a separate acceptance gate from running,
editing and testing Copse. A prepared installation can do the latter without
compiling native modules, but reinstalling or changing native dependencies can
require Python, a compiler and a compatible SDK. Those tools must also be bundled
and tested as part of complete development portability. Do not quietly depend
on the laptop's Xcode Command Line Tools.

## What belongs on the disk

| Contents                 | Preparation                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable Copse application | Keep a known-good packaged app alongside the development build. Support sequential use of the same everyday profile through `make run`; separate test profiles remain optional.           |
| Complete repositories    | Independent Git object databases, relevant branches, uncommitted/untracked work, submodules and required Git LFS objects.                                                                 |
| Development runtimes     | Node 24.20.0, pnpm 10.34.5 (including its offline bootstrap), standalone Git, ripgrep and required utilities; Python and native build tools where needed.                                 |
| Installed dependencies   | Prepared pnpm `node_modules`, Electron, matching Chromedriver, rebuilt node-pty, native `@napi-rs/keyring`, gortex and bundled skills. Keep architecture-specific installations separate. |
| Offline repair materials | pnpm lockfile/store, package archives/caches, Electron headers and downloads, original installers and a version/checksum manifest. A package cache alone is insufficient.                 |
| Local inference          | Model server executable, its dependent libraries/resources, model weights, tokenizer/config/template files and tested launch profiles.                                                    |
| Copse state              | Config/settings, chats, generated worktrees, memories, knowledge, long-task state, roadmap state, search indexes, relevant browser data and logs.                                         |
| Personal tooling         | Selected shell/Git configuration, instructions, skills, locally runnable MCP servers and their installed dependencies.                                                                    |
| Working materials        | Test repositories, fixtures, offline documentation, outstanding issues/specifications and a short launch/recovery guide.                                                                  |
| Optional editor          | A tested portable editor with its extensions and user-data directories on the disk, if Copse's editor is insufficient.                                                                    |

Inventory the software actually used across the intended projects before claiming
the whole development environment is portable. Add language runtimes, databases,
browser binaries and document tools only where those projects need them. Remote
services and account-backed tools need explicit offline alternatives or must be
marked unavailable. A VM/container can be useful for selected services, but is not
the baseline solution for testing the native Electron/Metal application.

For two Macs, APFS is appropriate and the observed volume already uses it. Do not
reformat it merely for this project. Consider encryption before storing private
repositories or portable credentials; establish a password-based unlock that
works on both machines. APFS supports external storage and encrypted volumes.
See [Apple's filesystem documentation](https://support.apple.com/guide/disk-utility/file-system-formats-dsku19ed921c/mac).

Suggested layout, rooted relative to the launcher:

```text
CopseKit/
  Launch Copse.command
  Open Dev Shell.command
  Stop Copse.command
  manifest.json
  apps/<os-arch>/
  toolchains/<os-arch>/
  models/
  projects/
  data/copse/
  home/
  cache/<os-arch>/
  tmp/
  docs/
  recovery/
```

For the complete supporting-software bundle:

- Ship standalone Node plus pinned pnpm, Git and its helpers/libraries, ripgrep, Python and
  required build utilities, with their data/configuration and cache directories.
- Include a compatible Apple compiler/SDK toolchain on the SSD, potentially via
  an Xcode application bundle. Resolve it per process using `DEVELOPER_DIR` and
  explicit tool/SDK paths. Validate a real node-pty rebuild on each laptop;
  first-run setup or licensing may still require a host-specific step. Merely
  copying the toolchain is not sufficient validation.
- Bundle the editor's extensions and data as well as its application. VS Code
  documents a macOS portable layout with a sibling data directory:
  [VS Code portable mode](https://code.visualstudio.com/docs/setup/portable).
- Package model-server libraries/resources, browser test binaries and local MCP
  dependencies explicitly. Disable implicit `npx`/package-manager downloads in
  the offline launch path.
- Treat an existing Homebrew installation as an inventory source, not as a
  relocatable binary distribution. Homebrew documents that many bottles require
  its default prefix: [Homebrew FAQ](https://docs.brew.sh/FAQ).
- Record every executable and non-system library in the manifest. The audit
  should allow macOS system frameworks and binaries while identifying any
  dependency on host Homebrew, a host language installation or a host SDK.

This is a bundled toolchain with a controlled launch environment. It does not
require replacing either laptop's login environment or relocating its entire
home directory.

Same architecture and compatible OS versions simplify sharing a development
installation. Mixed architectures require separate applications, native modules
and toolchains; share sources/model weights where compatible. Disk capacity is
not model capacity: weights and the context cache must fit the laptop's available
memory. Size the default profile for the smaller laptop, with an optional larger
profile for the other machine.

## Local model strategy

Use Copse's native agent with an explicitly selected local provider. The code
already supports LM Studio, Ollama and llama.cpp through OpenAI-compatible APIs;
a new inference integration is unnecessary.

For a minimal portable kit, evaluate a pinned `llama-server` distribution with
all its libraries/resources and local GGUF files. Launch using explicit on-disk
model paths, a stable model alias and a loopback-only endpoint. Verify the model's
chat template and structured tool calls in Copse, not just ordinary chat. The
[llama.cpp server documentation](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md)
describes its API and tool support. Portability of the chosen binary distribution
must still be tested on both Macs, including its dynamic-library dependencies.

If the user's existing models work best in LM Studio, retain it, but include its
downloaded inference runtimes and relocate/verify its application state as well
as its model directory. Offline operation does not establish application
portability. LM Studio documents that local inference and its local server work
offline, while downloading models and runtimes requires connectivity:
[LM Studio offline operation](https://lmstudio.ai/docs/app/offline).

Include one tested coding/tool-use model and a smaller fallback. Choose exact
weights, quantization and context after checking both laptops' RAM and the user's
existing models. Configure lightweight roles to reuse a loaded model initially;
several simultaneous models or excessive context can consume the available RAM.
Record speed, memory use and battery behaviour on the smaller laptop.

## Existing support and proposed code changes

The current paths already provide most of the profile relocation:

- `packages/store-kit/src/copse-paths.ts`: `COPSE_DIR` selects the shared profile
  root, including user data, threads, worktrees and scratch files.
- `src/main/app-init.ts`: resolves Electron user data before persistent stores
  are constructed. Legacy-profile migration can otherwise consult host data.
- `COPSE_PANEL_USER_DATA`, `COPSE_WORKSPACE_DIR` and `COPSE_WORKTREES_DIR` still
  take precedence for their individual locations; clear unintended overrides.
- `src/main/services/search/semantic-index.ts`: gortex uses a synthetic home under
  Electron user data, so its state largely follows that relocation already.

A wrapper using these variables can demonstrate the concept. The supporting
software and external integrations still need explicit relocation. Implement
the following in small, reviewable steps.

### 1. Use the existing root and relocate build caches

Use `COPSE_DIR` under the kit's `data/` directory; do not add a competing
`COPSE_PORTABLE_ROOT` resolver. Set `COPSE_PANEL_USER_DATA` to the corresponding
`user-data/` directory as well during portable launch to bypass automatic
migration of a legacy host profile. Existing profile relocation covers the
per-feature stores and sandbox scratch directory.

Build-time shared caches are a separate concern: `scripts/patch-dev-name.mts`
and `scripts/fetch-gortex.mts` default directly to `homedir()/.copse/cache`, not
to `COPSE_DIR`. Set `COPSE_ELECTRON_DIST_CACHE` and `COPSE_GORTEX_CACHE` to disk
directories before installation and launch. Recreate host-pointing Electron and
gortex symlinks. Relocate the pnpm store and Corepack/package-manager caches too;
keep pnpm's `.pnpm` dependency layout intact.

Audit host instruction/skill registries, MCP discovery and hook adapters.
Portable operation should use the curated disk profile for integrations, not
discover unrelated host profiles. If implementation touches hooks, first follow
`docs/plans/hooks-and-feature-packs.md`.

Do not solve this solely by globally replacing `HOME`: that affects shell startup,
credential discovery and sandbox assumptions. A disk-based child-process home
can be appropriate, with explicit paths and narrowly scoped sandbox rules.

### 2. Deterministic tool resolution

`augmentPathForGuiLaunch()` currently prepends Homebrew and home-directory tools
ahead of the supplied PATH. Portable mode must preserve disk toolchain priority
and omit host development-tool discovery. Give agent subprocesses, terminal tabs,
MCP servers and build commands a consistent environment, with explicit shell
configuration and package caches. Preserve credential filtering in
`child-process-env.ts`.

Audit absolute shebangs, symlinks, native library paths and subprocess lookups.
Copying a Homebrew prefix or a Python virtualenv is not sufficient evidence of
relocatability. Package complete dependency trees and validate their execution.
Grant sandbox reads for the selected toolchains/models and writes only for the
project and necessary cache/scratch locations; do not grant the whole disk.

### 3. Paths that survive switching laptops

Resolve portable project locations relative to the disk root, keeping stable
project/thread IDs. Handle a changed `/Volumes/...` mount point and paths with
spaces. Preserve historical transcript text; normalize active path references
with a structured migration rather than replacing every matching string.

Keep Git worktree administrative links entirely on the disk. Changing the mount
point may require worktree repair. Search indexes and daemon socket/PID state
must be reopened or rebuilt appropriately; never treat another machine's saved
PID as proof that a local process belongs to Copse.

### 4. Explicit offline configuration

Route chat, small tasks, review/advisor and enabled safety roles to verified local
models. Optional features should fail clearly or be disabled when unavailable.
Audit fallback paths: `resolve-agent-model.ts` can consider cloud providers and
`small-tasks-provider.ts` can fall back to the selected chat provider.

A proposed offline mode should block cloud fallback and defer update checks,
catalog refreshes, downloads and network-only integrations. It should still allow
the local model server, local MCP and local development servers. This is a
product-level behaviour policy; testing with external networking disabled is the
independent proof.
Existing shell approval/sandbox guarantees must remain intact.

### 5. Launch, shutdown and diagnosis

Launchers locate their own root, choose compatible binaries and a model profile,
check free space/version compatibility, start the local server and then Copse.
Check port ownership and do not accidentally connect to a pre-existing host
model server. Fail clearly if the disk is unavailable rather than creating a
fresh profile in the laptop's home directory.

Provide a diagnostic report of resolved paths and tool versions without secrets.
Shutdown stops Copse-owned model/search servers and child processes, flushes
stores, and releases the volume before eject. Add a single-writer guard and
careful stale-lock recovery; do not use PID alone across laptops.

## Migration sequence

1. **Inventory and compatibility:** confirm both machines and disk; enumerate
   intended projects, tools, model files and total sizes; identify every path or
   service that points outside the disk. Reserve space for builds, caches and
   recovery. No formatting or deletion is part of this plan.
2. **Prepare a copy:** retain the current working setup while validating the kit.
   This checkout's `.git` points to a host-side worktree admin directory, so do
   not copy its folder as the repository. Create an independent clone with its
   own objects, migrate required branches and dirty/untracked work, and fetch
   required submodule/LFS content while online. Avoid Git object alternates that
   reference the host. Recreate or repair worktrees on the disk.
3. **Prepare software online:** install pinned dependencies for each required
   architecture; run native rebuilds; obtain Electron/Chromedriver, gortex,
   bundled skills and model runtimes; collect offline repair artifacts. Keep a
   known-good packaged Copse separate from the editable source tree.
4. **Relocate state:** stop the source app before taking a consistent copy, map
   active project paths while preserving IDs, and copy the complete filesystem
   thread store as well as config/settings. Rebuild disposable indexes if needed.
5. **Configure local operation:** install launchers and path changes, use local
   model roles and curated integration settings, then perform the rehearsal below.
6. **Cut over after validation:** use the disk as the working environment only
   after both laptops pass. Keep an independent backup; a recovery directory on
   the same SSD does not protect against loss or disk failure.

Saved secrets need separate treatment. Latest main uses AES-256-GCM with `CPS2`
blobs in `packages/store-kit/src/keyring-cipher.ts`. Its random data key lives in
the OS keyring through `@napi-rs/keyring`, under service `Copse` and account
`secret-data-key` (`os-keyring.ts`). Electron `safeStorage` remains for legacy
read-time migration and as an encryption fallback if the primary is unavailable.
Thus the user was correct about the encryption migration, but copying the profile
still does not carry the key needed on the second laptop. This also affects
remembered SSH/VNC credentials, not just provider API keys.

The portable profile can operate with no cloud credentials. For portable saved
secrets, follow the linked device-bound plan: a new per-profile key, separate
enclave-protected envelopes, explicit asynchronous unlock, versioned authenticated
records and complete migration. Do not copy the account-wide key into an
unencrypted file or silently fall back to the old cipher. Prove native Touch ID
and ad-hoc `make run` interoperability before implementing migration.

Alternatively, supply optional provider credentials per session. Inventory Git
signing keys and credential helpers before relying on commits or later pushes.
Browser logins need separate validation. Current portability limits are recorded
in `docs/profiles.md` and `docs/recovery.md`.

## Acceptance: full portability across devices

On **each laptop**, cold-start with Wi-Fi disabled and host development paths
absent from the launch environment. A clean macOS user account is a useful
additional check against inherited user configuration, although it does not
remove system-wide tools. Inspect binary dependencies and the resolved tool paths
as well as running tests.

- Launch the known-good app and the development build from the SSD, with no
  downloads, host model server or missing-tool prompts.
- Load the chosen model and complete a real read/edit/shell/test agent task.
  Exercise enabled auxiliary model roles and check that none needs cloud access.
- Use `make run` for the supported launch path. Run `pnpm run check`,
  `pnpm run build` and local Electron e2e, including a focused
  screenshot eval of any changed visible state. Remote e2e cannot validate this
  offline two-laptop setup.
- Exercise terminal/node-pty, Git status/commit/worktrees, search, localhost
  browser preview and each promised local MCP integration.
- Validate an offline dependency restore and native rebuild in a disposable
  checkout, including all lifecycle download artifacts prepared in advance.
  Do not destroy the working installation to test this.
- Quit, stop owned services, eject, attach to the second laptop, reopen the same
  project and chat, and continue editing. Repeat the handoff back to the first.
- Test a mount path containing spaces and a different mount point. Inspect
  expected state/cache writes and verify no host development location is required.
- Record launch time, model responsiveness, memory pressure and power use, then
  keep a smaller model profile if the workflow exceeds the target machine's
  practical memory or power budget.
- Verify repeatable bundle updates, compatible helper/application upgrades and
  recovery from a failed update without introducing host-tool dependencies.
- Enroll an additional compatible device using the documented recovery process;
  the environment must not depend on undocumented setup on the original pair.

Deliver incrementally, but consider the environment complete only when its
applications, toolchains, model runtimes, credentials, working state and recovery
materials satisfy the declared portability boundary. A prepared app launch alone
does not establish a fully portable development environment.
