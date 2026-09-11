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
    cache/                   # pnpm, npm, Corepack, Electron, native headers, gortex
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

The scratch directory is a Git discovery ceiling, so a temporary non-repository
does not inherit the enclosing Copse checkout. Explicitly initialized scratch
repositories still work. The unit runner clears inherited Copse/Claude profile
overrides before starting test processes, preserving their fixture isolation.

Launchers derive the root from their own location. After moving the checkout or
changing the mount path, run `prepare` (or `prepare --offline`): it invalidates the dependency
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

## Offline setup and verification

Populate the drive once while connected, then verify the exact committed recipe:

```bash
make portable-setup
make portable-verify-offline
```

Verification requires a clean checkout. It creates an independent clone of the
current commit under `.portable/validation/offline.XXXXXX/checkout`, copies only
`cache/` using APFS copy-on-write, and runs setup without any preinstalled tools,
`node_modules`, build outputs or copied account profiles. macOS sandbox-exec
blocks network access and common host development caches, including
`~/.electron-gyp`, `~/.npm`, `~/.copse/cache` and `~/Library/Caches`. The build log
and result stay in that validation directory. The disposable directory can be
removed after review; it contains no copied personal profile.

After a successful verification, on either prepared Apple Silicon Mac:

```bash
make portable-setup-offline             # repair/reinstall tools and build
.portable/portable-dev prepare --offline # rebuild after edits or relocation
.portable/portable-dev exec --offline pnpm test -- portable-development
```

Offline mode disables npm/pnpm fetching and Corepack networking, checks cached
Node/Claude downloads against their pinned SHA-256 values, and denies networking
for the entire process tree, including lifecycle scripts. Missing cache inputs
fail instead of falling back to an online download. Reinstallation replaces
installed dependency trees: stop portable processes first, and keep the caches.
A failed repair may need an online setup to restore missing inputs.

Electron headers are installed into `cache/electron-headers/<version>` by the
locked node-gyp installer, which validates downloads against Electron's SHA-256
manifest. Native rebuild receives that directory explicitly rather than using
`~/.electron-gyp`. Other native modules use `cache/node-gyp`. The real user home
remains unchanged.

A passing verification applies to the tested commit, pins, cached assets and
platform. Repeat after dependency/tool updates. Newly added dependencies or
project-specific downloads must be cached while connected. `pnpm fetch` alone
cannot populate arbitrary lifecycle-script downloads.

## Optional LM Studio and models

```bash
make portable-local-ai-setup
make portable-local-ai-setup-offline # verify cached assets and reinstall the app offline
```

This opt-in download adds LM Studio 0.4.24-1 for Apple Silicon and three GGUF
models (about 72 GB of model weights combined). The default development setup
continues to install only the coding toolchain.

| Model                             | Quantization | Download | Intended use                                                                  |
| --------------------------------- | ------------ | -------- | ----------------------------------------------------------------------------- |
| Qwen3-4B-Instruct-2507            | Q4_K_M       | 2.50 GB  | Small local experiments and quick tests                                       |
| Qwen3.6-35B-A3B                   | Q4_K_M       | 21.17 GB | Larger coding/reasoning workloads; start with a modest context on a 32 GB Mac |
| Qwen3-Coder-Next (80B, 3B active) | Q4_K_M       | 48.49 GB | Coding model for the 64 GB Mac; start at 8K context                           |

`make portable-model` prints the largest downloaded tier appropriate for the
current Mac's physical memory: small from 16 GiB, medium from 32 GiB, large from
64 GiB. It falls back to a smaller downloaded model if needed. Use
`make portable-model MODEL_TIER=small` to select a tier explicitly; an oversized
explicit tier is refused. This recommends a file path and does not load a model
or change LM Studio's settings. Free memory and context size still matter.

The cached app lives at `.portable/apps/darwin-arm64/lm-studio-0.4.24-1/LM Studio.app`.
This version explicitly rejects launching outside `/Applications`, even through
an Applications symlink. The GUI therefore needs a real app copy on each Mac;
the cached bundle and model library can travel on the drive.

```bash
make portable-lm-studio-install # verify and copy cached app into /Applications; no downloads
make portable-lm-studio         # install if missing, then launch
make portable-claude            # drive-installed Claude Code CLI
make portable-codex             # drive-installed Codex CLI
```

The LM Studio launcher installs `/Applications/LM Studio Copse 0.4.24-1.app`,
verifies the publisher signature and version, and refuses an invalid existing
copy rather than replacing it. Quit other LM Studio instances first: otherwise
the app's single-instance behavior can silently activate the other copy. The
launcher reports this condition instead of closing a running app. Installation
needs write access to `/Applications` and works from the drive without internet.
It does not move profiles or select the model directory automatically.

Setup also creates `Launch LM Studio.command`, `Launch Claude Code.command` and
`Launch Codex CLI.command` inside `.portable/` for Finder. The CLI launchers
select the drive's tools and profiles. They do not install the Claude or Codex
desktop apps. Both CLIs require separate sign-in for these fresh profiles;
Claude's initial interactive startup also requires connectivity. `--version`
can run offline, but that is not proof of offline cloud-agent operation.

Models live under `.portable/models/lmstudio-community/`. `models.tsv` pins each
Hugging Face repository revision, filename, size, SHA-256 and recommended memory tier. The installer
checks the official DMG's pinned SHA-256 and Apple's code signature for Element
Labs before installing. It verifies model checksums on every run.

LM Studio's current per-user profile and inference runtime storage are separate
from the app bundle. Installing a second app copy does not create a separate
profile. This recipe deliberately leaves the host's profile, model-library
selection, running server and shell configuration unchanged. Select the drive's
model directory in LM Studio's My Models page when you want to use that library;
that selection affects the active host profile. The runtime target below provisions the engine software separately; activating
that runtime location in an LM Studio profile and loading a model remain
separate steps. `portable-verify-offline` checks the development toolchain,
not LM Studio inference.

Model weights are not extra RAM: the larger model still needs memory for its
context and runtime. Use one model at a time and a modest context. The small
model is provided for lighter machines. Qwen3-Coder-Next should only be loaded
on the 64 GB Mac, with enough free memory for the OS, Copse and its context cache;
the 32 GB laptop should use Qwen3.6 or the small model. These are starting
configurations, not a guarantee of peak memory use. Load-test the large model
on the 64 GB machine before relying on that configuration. Model downloads use LM Studio's
published [Qwen3-4B](https://huggingface.co/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF),
[Qwen3.6](https://huggingface.co/lmstudio-community/Qwen3.6-35B-A3B-GGUF),
and [Qwen3-Coder-Next](https://huggingface.co/lmstudio-community/Qwen3-Coder-Next-GGUF) repositories.

## Expanded model library and inference runtimes

```bash
make portable-local-ai-library          # optional public collection: about 197 GB
make portable-local-ai-library-offline  # verify/reconstruct from files already present
make portable-local-ai-runtimes         # pinned GGUF, MLX, Harmony and Python archives
make portable-local-ai-runtimes-offline # reinstall from caches; also run after relocation
```

The public expanded collection is opt-in and adds 16 model repositories
(including the Nomic embedding model), with 121 files. Alongside the three
starter models, the combined weights and supporting files occupy about 269 GB
before filesystem sharing. Separate MLX/GGUF and 4/6/8-bit variants remain separate selections.
Repeated entries for the same model on multiple machines are consolidated.

`scripts/portable/collections/extended.tsv` pins every required file: repository,
immutable revision, filename, SHA-256 and byte size. MLX entries include their
configuration, tokenizer, processor and index files; GGUF vision entries include
projectors. Files preserved from an existing installation are matched to their
publisher's history, so individual files can have different revision pins.
Remote-only entries use the exact variant's publisher revision at collection
time; they are not asserted to be byte-identical to an inaccessible installation.

The separately gated ThinkingCap GGUF variant and its projector are pinned in
`scripts/portable/collections/extended-gated.tsv` (about 18 GB). To install them,
obtain the publisher's access through Hugging Face, configure `HF_TOKEN` securely
in the invoking environment, and select that manifest with `MODEL_MANIFEST`.
The installer only sends this token to Hugging Face, through curl's stdin; it
never writes the token into the drive, a manifest or a command argument.
Cached gated files can subsequently be verified offline without credentials.
This optional gated collection brings the combined library to about 287 GB.

Use `MODEL_MANIFEST=/absolute/path/collection.tsv` for another collection with
those five tab-separated fields. The installer rejects malformed pins,
duplicate destinations, path traversal and destination symlinks. Each first
occurrence of a checksum is verified; later identical files are materialized
with APFS copy-on-write (ordinary copies on filesystems without clone support).
This preserves complete model directories without downloading identical bytes
again. Offline mode refuses missing or corrupt files unless an identical,
already-verified file in the collection can supply them.

Runtime software is installed at
`.portable/apps/darwin-arm64/lm-studio-runtimes/`. The official registry's pinned
archives are retained under `.portable/cache/downloads/lm-studio-runtimes/`.
`runtimes.tsv` pins Metal llama.cpp 2.34.0, MLX 1.11.0, Harmony 0.3.5 and their
shared Python dependencies. These are public software packages; the installer
never copies an LM Studio user profile or credentials.

Stop processes using the portable runtimes before reinstalling them. Runtime
setup replaces its managed software directory and runs the archive's bundled
venvstacks postinstall scripts using its own Python interpreter. Those scripts
regenerate absolute Python environment paths, so rerun the offline runtime
target whenever the mount path changes. The host app's runtime selections and
profile remain unchanged: installing these packages does not activate a second
isolated LM Studio GUI profile automatically.

The runtime executables also support direct use of the drive's models without
changing the host GUI profile. Enter `make portable-shell` first so temporary
files and caches also stay on the drive. For example, after installing the expanded library:

```bash
COPSE_LOCAL_AI_RUNTIME="$PWD/.portable/apps/darwin-arm64/lm-studio-runtimes"
"$COPSE_LOCAL_AI_RUNTIME/vendor/_amphibian/app-mlx-generate-mac14-arm64@34/bin/python" -I \
  -m mlx_vlm.generate --model "$PWD/.portable/models/lmstudio-community/gemma-4-E4B-it-MLX-4bit" \
  --prompt "Reply with just the word ready." --max-tokens 8 --thinking-mode disabled
```

The GGUF server is at
`$COPSE_LOCAL_AI_RUNTIME/llama.cpp-mac-arm64-apple-metal-advsimd-2.34.0/llama-server`.
Select a model and a modest context explicitly; a server may be connected to a
client over localhost. These direct executables are separate from the LM Studio
GUI's active per-user configuration.

## Boundaries

Apple's SDK, OS permissions, Keychain and system utilities remain host dependencies.
Install/select Command Line Tools or Xcode on each Mac before travelling. Offline
setup reconstructs Copse and its pinned tools; it cannot provision a bare Mac's
Apple SDK or provide cloud inference without a connection.

Claude's launcher disables updates so its pinned version stays selected. Codex's
wrapper selects `data/codex` only for the child process. Fresh Codex profiles use
the OS keychain. Claude uses its configured directory and normally the Mac
keychain; credentials can fall back to a file when keychain writes fail. Sign in
separately on each Mac. Setup never imports host secrets. Profile relocation does
not implement portable secret encryption. Copse ACP sandbox access to relocated
agent state still needs end-to-end validation.

Cloud inference requires a connection. The optional local AI recipe downloads
model weights and LM Studio; the runtime target also installs the engine software.
LM Studio profile activation and model load testing remain separate.
Desktop Claude/Codex apps, project-specific tools and a second-Mac acceptance run
are not included in this preview. First-time account sign-in requires a connection.
`doctor` reports prerequisites and executable paths; `verify-offline` proves
installation and compilation from the available caches on the current Mac.

To update tools, review `versions.sh` and `tools/package.json`, regenerate
`tools/package-lock.json` with the pinned Node's npm, then rerun setup and the
relocation checks. Do not replace pins with `latest` in the setup script.
