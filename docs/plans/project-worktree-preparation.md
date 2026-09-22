# Project worktree preparation

Tracking: #2376 and #2654; foundation: #2388. This replaces the Copse-source-only scope of the original bootstrap proposal.

## Product contract

Worktree readiness is a capability for the user's project. The application must not check a repository name, assume Electron, require a particular test framework, or import its own development scripts to decide which native artifacts another project needs.

Preflight is read-only. It returns the detected package manager, runtime requirements, dependency state, declared checks, exact preparation commands, configuration problems, and a plan fingerprint. Preparation approves those commands once, checks the fingerprint again during execution, and records readiness only after the required checks pass. Readiness means dependencies and declared setup are ready; it never implies the project's build or tests pass.

## Implemented scope

- Automatic JavaScript adapters: npm, pnpm, Yarn Classic, modern Yarn (including Plug'n'Play), and Bun. Prefer an exact `packageManager` declaration; otherwise require an unambiguous lockfile. No package name, scripts field, or `.nvmrc` is required. Respect Node version files and `engines.node` when present.
- Automatic Python adapter: a root `pyproject.toml` and `uv.lock` select uv. Run `uv sync --locked --all-packages --no-python-downloads` against the project's `.venv`, including workspace packages and default dependency groups. uv enforces Python constraints and lock freshness; an installed compatible Python and uv are prerequisites. This does not install Python or uv globally. An explicit declaration owns non-JavaScript setup and can override detection; mixed JavaScript/Python roots and conflicting Python locks require that declaration or selection of a nested project.
- Automatic Go adapter: a root `go.mod` or `go.work` selects Go modules. Load the package and test import graph with `go list -mod=readonly -deps -test all`, then verify downloaded inputs with `go mod verify`. `GOTOOLCHAIN=local` forbids runtime/toolchain downloads; `GOENV=off`, a fixed `GOWORK`, and `GOFLAGS=-mod=readonly` prevent ambient configuration from changing the approved plan. The adapter does not run `go generate`, compile packages, or execute tests, so readiness is not a build or test result. Mixed ecosystem roots require an explicit declaration or selection of a nested project.
- Automatic Cargo adapter: a root `Cargo.toml` and reviewed `Cargo.lock` select Rust dependency fetching. `cargo fetch --locked` populates a private Copse-managed `CARGO_HOME`; readiness repeats that command with `--offline`. The adapter invokes canonical `cargo` and `rustc` binaries from an already-installed toolchain directly, never a rustup proxy, and does not compile crates, run build scripts, tests, or project binaries. Project/ancestor Cargo configuration, local path/workspace manifests, and `rust-toolchain.toml` require a reviewed declaration; automatic setup accepts registry/Git dependencies and an optional bounded plain `rust-toolchain` channel.
- Frozen/immutable installs; no automatic lockfile generation or package-manager migration. Include development dependencies. General install lifecycle scripts remain disabled.
- Any other ecosystem can declare preparation commands and read-only checks in `.copse/worktree-preparation.json`. This is a general extension mechanism, not a claim that every ecosystem is automatically detected. An unknown project gets actionable configuration guidance rather than a false `ready` result.
- Project-specific native setup is opt-in through the same declaration. Copse's Electron/gortex setup becomes one ordinary declaration in this repository; there is no privileged application-side adapter for it.
- Fingerprint runtime/package-manager identity, lockfiles, package manifests throughout the project (including `apps/`), package configuration, patches, the declaration, and additional declared inputs. Never reuse readiness merely because `node_modules` exists.
- Preserve OS containment and read-only/offline preflight. Approved commands may write only the execution root and enumerated managed caches. No configurable home-directory grant, arbitrary cache roots, or unsandboxed fallback.
- Approval names project-defined commands as executable repository code. A declaration is not a trust grant. Changing its inputs invalidates the plan fingerprint and requires a new approval.

## Declaration

```json
{
  "version": 1,
  "inputs": ["requirements.lock", "scripts/setup.py"],
  "prepare": [
    { "command": "python3", "args": ["-m", "venv", ".venv"] },
    {
      "command": ".venv/bin/python",
      "args": ["-m", "pip", "install", "--require-hashes", "-r", "requirements.lock"]
    }
  ],
  "checks": [
    {
      "name": "Python environment",
      "path": ".venv/bin/python",
      "command": { "command": ".venv/bin/python", "args": ["-m", "pip", "check"] }
    }
  ]
}
```

Commands are argv arrays, run sequentially from the selected project root. No shell parsing is implicit. Explicitly invoking a shell is possible and appears in approval. `inputs` names files/directories whose changes invalidate readiness. `checks` require a path, a command, or both; commands must exit successfully and may require `outputIncludes`. Checks always run read-only with network blocked. Set `fingerprintOutput: true` on deterministic version checks to invalidate readiness when their runtime output changes. Declare a meaningful check for each setup output. An explicit `{ "version": 1 }` means this project needs no setup.

The host does not invent safe flags for arbitrary project-defined commands: their precise code and package policy are part of the visible approval. Python source builds, Cargo build scripts, and other ecosystem-specific execution must not be described as having JavaScript's disabled-lifecycle guarantee. Offline mode is enforced for all of them by the kernel, regardless of CLI flags.

## Acceptance and evidence

- Ordinary fixtures for npm, pnpm, both Yarn families, and Bun reach readiness without any Copse package metadata or native artifacts.
- A non-Node fixture prepares and reuses declared outputs without a Node binary on project PATH.
- Missing/ambiguous lockfiles, invalid configuration, unavailable runtime versions, malformed fingerprints, removed outputs, and offline cache misses give accurate results.
- Changed manifests outside `packages/`, changed declared scripts, and runtime changes invalidate readiness.
- Malicious probes cannot write; approved scripts cannot escape through symlinks; offline runs cannot inherit another agent's network grant; changed approval plans cannot execute.
- Real package-manager smoke runs exercise install flags, disabled lifecycle scripts, and reuse. A focused Electron screenshot demonstrates generic project results.

## Follow-up sequence

1. Land and validate this general foundation, keeping #2388 draft until its expanded CI passes.
2. #2654: uv, Go modules, and Cargo fetching are automatic non-JavaScript adapters (details below). Hash-locked pip remains. Each adapter needs documented lock/constraint handling, cache identity, offline behavior, toolchain requirements, and build-script policy, plus real sandbox installation fixtures. Declarations already support projects outside the automatic boundary.
3. #2655: Add Maven/Gradle, .NET/NuGet, Ruby/Bundler, and PHP/Composer using the same adapter contract and evidence. Do not market automatic support until its adapter and tests ship.
4. Improve configuration discovery/authoring and mixed-ecosystem monorepo reporting. Preserve project-root confinement and explicit approval when selecting setup commands.
5. Run #1916's end-to-end approval-budget regression across different project types. #2377 (linked-worktree Git) and #2378 (edit ownership) remain independent prerequisites for reducing the rest of that friction; neither provides package-manager support.

Runtime installation/version switching and Windows sandbox support are separate capabilities. Preparation reports an unavailable runtime and the required version; it does not silently install tools globally or relax its boundary.

## Python adapter evidence and remaining work (#2654)

uv readiness checks the manager identity, selected interpreter, environment runtime identity, and `uv sync --locked --all-packages --check --offline --no-cache --no-python-downloads`. A success stamp alone never substitutes for that check. Root/workspace Python manifests, uv configuration, Python version files, and the lockfile invalidate the plan. uv's own check decides whether the installed distribution metadata matches the locked environment. This is not an integrity scan of every installed source file or a claim that tests pass.

uv initializes bookkeeping even during `--check`. Every preflight subprocess therefore receives a private disposable scratch directory; only that directory is writable, and it is removed after success or failure. The project, shared caches, and unrelated host files remain read-only. `--no-cache` directs uv's check to disposable storage; installation and later shells use the fixed managed `uv` cache. Offline mode still has kernel network isolation. Python builds may execute backend/repository code and are labelled accordingly in approval; they do not inherit the JavaScript disabled-lifecycle claim.

The real uv regression creates an unrelated application with a local wheel, consumes its reviewed lock, installs/imports the dependency, reuses preparation offline, repairs removed distribution metadata, and rejects changed manifests/stale locks without rewriting the lock. It uses the host's installed uv and Python and explicitly skips only that fixture when those tools are absent. Unit and sandbox-boundary coverage do not require uv. A focused Electron eval captures the automatic Python approval.

Validated against uv 0.12.2. Command semantics: [uv CLI reference](https://docs.astral.sh/uv/reference/cli/). Hash-locked pip remains in #2654; JVM/.NET/Ruby/PHP remain in #2655. Neither issue is complete merely because some adapters are supported.

## Go adapter evidence and remaining work (#2654)

Go readiness fingerprints root/workspace `go.mod`, `go.sum`, `go.work`, `go.work.sum`, and `.go` sources, including nested modules. Local `go.work use` and `replace` targets are resolved relative to their declaring file and must remain in the selected checkout; symlinks are checked through the same contained-path boundary. Adding or changing a source import therefore invalidates the approved plan before another command runs.

Preparation runs `go list -mod=readonly -deps -test all`. This loads package and test import metadata and populates missing modules, without invoking generators, builds, or tests. Copse does not use `go mod download all`: the Go tool's own regression suite documents that download can update `go.mod` and `go.sum`, even when loading `all`. The selected command instead fails on stale module metadata and the OS sandbox keeps the project read-only during automatic Go preparation.

`GOMODCACHE` is a fixed Copse-managed cache. Both preflight and automatic Go preparation point `GOCACHE` and `GOTMPDIR` to per-process disposable scratch, so package loading can perform bookkeeping without writing the project. Preflight mounts the module cache read-only; approved preparation may write the managed module cache. The project remains read-only in both modes. Offline preparation sets `GOPROXY=off`; every offline child also retains kernel network isolation. `GOTOOLCHAIN=local` forbids automatic toolchain downloads, and the installed Go runtime is fingerprinted as readiness identity.

The real sandbox regression authors an unrelated module through a local file proxy, consumes its reviewed `go.sum`, runs the dependency, reuses it offline, detects a modified extracted module with `go mod verify`, repairs a removed extraction from the cached zip, and rejects stale source imports without rewriting `go.mod` or `go.sum`. It also proves the automatic prepare process cannot write the project. The focused Electron eval captures the readonly command and its explicit no-generate/build/test scope.

Command and cache semantics: [Go modules reference](https://go.dev/ref/mod), [Go command reference](https://pkg.go.dev/cmd/go), [toolchain selection](https://go.dev/doc/toolchain), and the Go project's [`go mod download` mutation regression](https://go.dev/src/cmd/go/testdata/script/mod_download.txt). Validated against Go 1.26.5. This is only the Go adapter portion of #2654.

## Cargo adapter evidence and remaining work (#2654)

Cargo readiness fingerprints every in-tree `Cargo.toml`, the root `Cargo.lock`, root Cargo configuration, and rust-toolchain selection files. Without a TOML parser, the automatic adapter accepts only a narrow lexical subset: it fails closed on every manifest containing local path/workspace text or any backslash/escape, on `rust-toolchain.toml`, and when an enclosing `Cargo.toml` could select a workspace outside the chosen project. Those projects use the existing reviewed declaration path. This avoids making containment or toolchain selection depend on an incomplete textual grammar. A missing or stale lock fails rather than being generated or rewritten.

Preparation runs `cargo fetch --locked --manifest-path Cargo.toml`; the read-only check adds `--offline`. This fetches dependency sources for every target represented by the lock. It does not compile crates, execute `build.rs`, run tests, or run project binaries, so readiness is not package loading, compilation, or test success. Cargo configuration can itself select executable credential providers, wrappers, compilers, runners, environment, included files, or external Git, and array values from different configuration levels concatenate. The automatic adapter therefore rejects root and ancestor Cargo configuration rather than trying to override selected keys, and clears ambient `CARGO_*` and `RUST*` controls before restoring only its fixed cache/offline settings. Projects needing those capabilities use an explicit reviewed declaration.

`CARGO_HOME` is a private Copse-managed cache that general declarations cannot write. The runner rejects Cargo home configuration, credentials, and redirected structural cache directories before every subprocess. Preflight mounts the cache read-only; approved preparation may write it while the project and lock remain read-only. Both modes use disposable scratch. The adapter resolves a canonical, already-installed Cargo/rustc pair and executes it directly, excluding rustup proxies and ambient PATH wrappers; an unavailable requested toolchain fails rather than falling back or downloading. Offline checks also retain kernel network isolation.

The real sandbox regression authors an unrelated local Git dependency with a `build.rs` side-effect marker, consumes its reviewed lock, fetches through Cargo's built-in Git transport, reuses the result offline, repairs a removed checkout from the cached Git database, and rejects a stale manifest without rewriting the lock or executing the build script. Separate boundary coverage rejects every Cargo configuration level, local path/workspace declarations (including quoted/escaped forms), invalid toolchain selections, and cache/toolchain symlinks; proves the project and shared cache stay read-only during preflight; and scrubs ambient wrappers and credentials.

Command and cache semantics: [cargo fetch](https://doc.rust-lang.org/cargo/commands/cargo-fetch.html), [Cargo configuration](https://doc.rust-lang.org/cargo/reference/config.html), [Cargo home](https://doc.rust-lang.org/cargo/guide/cargo-home.html), and [workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html). Validated against Cargo 1.97.1. This is only the Cargo adapter portion of #2654; hash-locked pip remains outstanding and #2654 stays open.
