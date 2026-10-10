# Dependency approval prototype

Standalone, host-owned approval model; does not change Copse's live shell policy or run installs.

Task brief: make repeated installs of approved dependency inputs automatic, while showing what
changed before approving a new set. Base: `72f7d6c2b70cf5ee314c588b2d055723e27b1892`.
Acceptance: persistent exact-snapshot approval; additions/removals/integrity changes in review;
configuration changes require a matching approval; stale dialogs and cross-project reuse fail.
Project approvals carry across chats and worktrees with the exact approved inputs. Multiple
approved snapshots survive branch switches and restarts. There is no chat-only grant option.
Security contract: approval does not grant network, credentials, or sandbox escape. No Electron
UI changes. Validate focused tests, demo, typecheck, and the repository check gate.

Run from the repository root with its Node 24 toolchain:

```sh
node scripts/prototypes/dependency-approval/demo.mts
pnpm test -- scripts/prototypes/dependency-approval/model.test.ts
```

## Project approval scope

Dependency approval is always project-scoped. Any chat or worktree belonging to the same
host-identified project can reuse an exact approved snapshot. Bind approval to package versions,
integrity, sources, manifests and configuration, rather than a branch name or absolute worktree
path. Do not infer shared project identity from an agent-supplied path or remote URL.

Retain multiple approved snapshots per project so switching between previously approved branches
does not prompt again. New inputs require approval unless their exact snapshot is already approved;
committing changes does not approve them. Record the requesting chat and approval provenance for
each grant. The planned approval card offers **Approve for this project**; there is no chat-only
choice. Legacy thread-scoped prototype rows are ignored and require fresh project approval,
so previously granted consent is never silently widened.

Installed state remains per environment/worktree: shared approval does not mean dependencies are
already installed. Lifecycle capability grants, network exceptions, credentials and broader script
access remain separately scoped and do not transfer through dependency approval. Every execution
must still satisfy the containment contract and existing permission gates.

Implemented model:

- Project-owned grants keyed by exact snapshot digest, retaining multiple approved snapshots.
- Original approving chat, worktree root and timestamp recorded as provenance; repeated approval
  of the same snapshot preserves that original record.
- Exact historical matches reuse approval and show no changes. New snapshots compare against
  the project's most recently added approval; review exposes its digest as the comparison baseline.
- Tests cover cross-chat/worktree reuse, persistent branch snapshots, project isolation, stale
  reviews, configuration changes and refusal to promote legacy thread grants.

Remaining integration: resolve project membership through the host, keep environment/worktree
installation records separate, and show “Using project-approved dependencies” for reuse. There is
no installation-state tracker or approval UI in this standalone model.

## Current prototype behavior

`DependencyApprovals` accepts a SQLite path (memory by default). Store it outside every agent-writable
mount. Authorization uses only the host-supplied project ID and snapshot digest. Thread ID and
canonical workspace root are provenance, not grant boundaries. Review returns
added, removed and changed package identities plus changed input paths; it never returns config
contents. Version changes appear as removal/addition. First use requires approval: neither a Git
commit nor an existing lockfile is evidence of consent. All approved snapshots are retained.

The input map must be a complete immutable staging manifest from a trusted collector: lockfile,
all workspace manifests, workspace configuration, npm configuration, patches, hook files and local
package contents. This prototype hashes supplied bytes, not a live filesystem. It does not implement
that collector, detect omitted inputs, or parse workspace globs. Hashing all staging files is conservative:
source-only changes may prompt again. Lock parsing supports pnpm v9 and rejects malformed input;
it extracts package identities for display, not an executable artifact allowlist. Full lock bytes bind
integrity, sources, importer resolution and snapshot graph even when display metadata is unchanged.
Dependency lifecycle scripts cannot be reliably discovered from a lockfile; scripts remain disabled.

`approve` belongs exclusively behind a host-owned user approval action. Re-capture the inputs and
supply the digest actually reviewed. `plan` accepts only plain `pnpm install` (optionally frozen),
requires a matching approval and emits a restricted two-phase plan. It never spawns a process.

Before live integration, implement and validate:

- An immutable staging collector and atomic handoff to execution, including symlink confinement,
  workspace/local dependencies, config and patch discovery, bounded parsing, and concurrent edits.
- A pinned trusted pnpm executable with no ambient environment/user config or project hooks.
- An artifact broker restricted to approved package/version/integrity requests; reject unsupported
  Git, local and custom-registry sources until they have explicit handlers. A host allowlist alone
  does not stop exfiltration. Credentials belong to the broker, never the child process.
- Kernel-enforced offline install/build isolation with a private verified store, no host sockets,
  no secrets, and narrowly staged inputs/outputs. Fetch must not see workspace source or config.
- Separate lifecycle capability approval, direct/transitive display grouping, the existing policy
  gates and user approval UI, plus tests against a real contained install and attempted exfiltration.

The demo simulates the host approval action; it is not a user authorization endpoint. The returned
plan's containment descriptions are requirements, not attestations. `executableHere` is always false.

## Completion evidence

Standalone prototype based on the SHA above; no live permission change. The PR records the
final source commit and validation results.

- `node scripts/run-tests.mts scripts/prototypes/dependency-approval/model.test.ts`: 4 tests passed (including legacy approval handling and cross-chat/worktree reuse).
- `node scripts/prototypes/dependency-approval/demo.mts`: passed through initial review, repeat
  install planning, added dependency review and reapproval.
- `node node_modules/eslint/bin/eslint.js scripts/prototypes/dependency-approval/`: passed.
- `node node_modules/oxfmt/bin/oxfmt --check scripts/prototypes/dependency-approval`: passed.
- `PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm run check`:
  e2e syntax passed; stopped at existing type errors outside this prototype (LM Studio test arity,
  missing Mermaid build module, missing undici and resulting implicit-any errors). No prototype
  type errors reported. Later full-gate stages did not run. Environment overrides avoid this
  machine's pnpm attempting dependency installation before script execution.

No independent review or real sandbox/exfiltration test performed. Live integration remains the
work listed above; this experiment establishes the approval state machine only.
