# Project worktree preparation

Tracking: #2376; implementation: #2388. This replaces the Copse-source-only scope of the original bootstrap proposal.

## Product contract

Worktree readiness is a capability for the user's project. The application must not check a repository name, assume Electron, require a particular test framework, or import its own development scripts to decide which native artifacts another project needs.

Preflight is read-only. It returns the detected package manager, runtime requirements, dependency state, declared checks, exact preparation commands, configuration problems, and a plan fingerprint. Preparation approves those commands once, checks the fingerprint again during execution, and records readiness only after the required checks pass. Readiness means dependencies and declared setup are ready; it never implies the project's build or tests pass.

## Scope implemented in #2388

- Automatic JavaScript adapters: npm, pnpm, Yarn Classic, modern Yarn (including Plug'n'Play), and Bun. Prefer an exact `packageManager` declaration; otherwise require an unambiguous lockfile. No package name, scripts field, or `.nvmrc` is required. Respect Node version files and `engines.node` when present.
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
2. #2654: Add zero-configuration adapters for Python (uv and locked pip), Rust (Cargo), and Go. Each adapter needs documented lock/constraint handling, cache identity, offline behavior, toolchain requirements, and build-script policy, plus real sandbox installation fixtures. Declarations already support these projects while adapters are developed.
3. #2655: Add Maven/Gradle, .NET/NuGet, Ruby/Bundler, and PHP/Composer using the same adapter contract and evidence. Do not market automatic support until its adapter and tests ship.
4. Improve configuration discovery/authoring and mixed-ecosystem monorepo reporting. Preserve project-root confinement and explicit approval when selecting setup commands.
5. Run #1916's end-to-end approval-budget regression across different project types. #2377 (linked-worktree Git) and #2378 (edit ownership) remain independent prerequisites for reducing the rest of that friction; neither provides package-manager support.

Runtime installation/version switching and Windows sandbox support are separate capabilities. Preparation reports an unavailable runtime and the required version; it does not silently install tools globally or relax its boundary.
