# Project worktree preparation

Tracking: #2376 and #2654; foundation: #2388. This replaces the Copse-source-only scope of the original bootstrap proposal.

## Product contract

Worktree readiness is a capability for the user's project. The application must not check a repository name, assume Electron, require a particular test framework, or import its own development scripts to decide which native artifacts another project needs.

Preflight is read-only. It returns the detected package manager, runtime requirements, dependency state, declared checks, exact preparation commands, configuration problems, and a plan fingerprint. Preparation approves those commands once, checks the fingerprint again during execution, and records readiness only after the required checks pass. Readiness means dependencies and declared setup are ready; it never implies the project's build or tests pass.

## Implemented scope

- Automatic JavaScript adapters: npm, pnpm, Yarn Classic, modern Yarn (including Plug'n'Play), and Bun. Prefer an exact `packageManager` declaration; otherwise require an unambiguous lockfile. No package name, scripts field, or `.nvmrc` is required. Respect Node version files and `engines.node` when present.
- Automatic Python adapter: a root `pyproject.toml` and `uv.lock` select uv. Run `uv sync --locked --all-packages --no-python-downloads` against the project's `.venv`, including workspace packages and default dependency groups. uv enforces Python constraints and lock freshness; an installed compatible Python and uv are prerequisites. This does not install Python or uv globally. An explicit declaration owns non-JavaScript setup and can override detection; mixed JavaScript/Python roots and conflicting Python locks require that declaration or selection of a nested project.
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
2. #2654: uv is the first automatic non-JavaScript adapter (details below). Hash-locked pip, Rust (Cargo), and Go remain next. Each adapter needs documented lock/constraint handling, cache identity, offline behavior, toolchain requirements, and build-script policy, plus real sandbox installation fixtures. Declarations already support these projects while adapters are developed.
3. #2655: Add Maven/Gradle, .NET/NuGet, Ruby/Bundler, and PHP/Composer using the same adapter contract and evidence. Do not market automatic support until its adapter and tests ship.
4. Improve configuration discovery/authoring and mixed-ecosystem monorepo reporting. Preserve project-root confinement and explicit approval when selecting setup commands.
5. Run #1916's end-to-end approval-budget regression across different project types. #2377 (linked-worktree Git) and #2378 (edit ownership) remain independent prerequisites for reducing the rest of that friction; neither provides package-manager support.

Runtime installation/version switching and Windows sandbox support are separate capabilities. Preparation reports an unavailable runtime and the required version; it does not silently install tools globally or relax its boundary.

## Python adapter evidence and remaining work (#2654)

uv readiness checks the manager identity, selected interpreter, environment runtime identity, and `uv sync --locked --all-packages --check --offline --no-cache --no-python-downloads`. A success stamp alone never substitutes for that check. Root/workspace Python manifests, uv configuration, Python version files, and the lockfile invalidate the plan. uv's own check decides whether the installed distribution metadata matches the locked environment. This is not an integrity scan of every installed source file or a claim that tests pass.

uv initializes bookkeeping even during `--check`. Every preflight subprocess therefore receives a private disposable scratch directory; only that directory is writable, and it is removed after success or failure. The project, shared caches, and unrelated host files remain read-only. `--no-cache` directs uv's check to disposable storage; installation and later shells use the fixed managed `uv` cache. Offline mode still has kernel network isolation. Python builds may execute backend/repository code and are labelled accordingly in approval; they do not inherit the JavaScript disabled-lifecycle claim.

The real uv regression creates an unrelated application with a local wheel, consumes its reviewed lock, installs/imports the dependency, reuses preparation offline, repairs removed distribution metadata, and rejects changed manifests/stale locks without rewriting the lock. It uses the host's installed uv and Python and explicitly skips only that fixture when those tools are absent. Unit and sandbox-boundary coverage do not require uv. A focused Electron eval captures the automatic Python approval.

Validated against uv 0.12.2. Command semantics: [uv CLI reference](https://docs.astral.sh/uv/reference/cli/). Hash-locked pip, Cargo and Go remain the next adapters in #2654; JVM/.NET/Ruby/PHP remain in #2655. Neither issue is complete merely because uv is supported.
