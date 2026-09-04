# @copse/shell-guard

Deterministic classification of shell command lines for an agent harness, extracted
from `src/main/services/security/` into an in-repo workspace package — the same
staging step `@copse/llm`, `@copse/agent`, and `@copse/plan-usage` took. About
4,500 LOC plus tests; one runtime dependency (`shell-quote`); no host-app imports.

Everything here is a heuristic **for permission prompts**, not a security boundary.
On macOS the project seatbelt is the real confinement; elsewhere the verdicts decide
what the user is asked. The safety model, platform matrix, and the rules for
changing any of this are in `docs/shell-permissions.md`, which remains the binding
contract.

## What's in it

- **`shell-argv.ts`** — lexing (`shellSegments`, `shellRedirects`), wrapper
  unwrapping (`env`, `nice`, `time`, …), interpreter and inline-code detection, and
  the read-only command tables (`READ_ONLY_SHELL_BASENAMES`,
  `READ_ONLY_GIT_SUBCOMMANDS`).
- **`shell-scope.ts`** — `analyzeShellCommand(command, workspaceRoot)`: `sandbox` /
  `ambiguous` / `external` with human-readable reasons; `dangerousInSandboxReasons`
  for destructive shapes that must prompt even when contained.
- **`shell-harm.ts`** — `assessShellHarm`: the Guarded YOLO harm gate (`allow` /
  `prompt` / `deny`), independent of scope so nothing downstream can downgrade it.
- **`read-outside-project.ts`** — `analyzeReadOutsideProject`: proves a command only
  reads named paths outside the project, and which paths a seatbelt may be widened
  to.
- **`gh-argv.ts`** — `classifyGhSegment`: which GitHub CLI shapes only read, which
  write to the user's own repository, and the flags a write may carry.
- **`command-routing.ts`** + **`trusted-commands.ts`** — the trusted-command
  allow-list: resolution (`routeShellCommand`) and the Node-free types and text
  serialization the Settings renderer imports.

## The host environment seam

Two facts the classifier needs are the host's to know, so `shell-scope.ts` takes
them through `configureShellScopeEnvironment`:

- `containedReadRoot` — a directory the sandbox mounts read-only, so a
  structurally read-only command naming a path under it is contained rather than
  an escape. Copse binds its chat store (`~/.copse/workspace`).
- `sanctionedScratchMatcher` — scratch directories the host sanctions, masked out
  before the outside-path rules run. Copse binds the directories its configured
  ACP agents declare.

Both default to "nothing sanctioned", the strictest reading. The app installs its
values once in `src/main/services/security/shell-guard-environment.ts`, which every
app-side re-export imports for its side effect, so any path into the classifier
from app code sees the same roots the seatbelt does.

## Imports

App code keeps importing `./shell-argv.ts`, `./shell-scope.ts`, `./shell-harm.ts`,
`./command-routing.ts`, and `./read-outside-project.ts` from
`src/main/services/security/` (and `@shared/command-routing.ts` from the renderer);
those files are re-exports of this package. The read-outside approval-prompt copy
(`formatReadOutsideProjectPromptParts`, the title and warning) is product UX and
stays in the app-side `read-outside-project.ts`.

## Standalone path

The dependency is resolved through the manifest, so a future move to its own
repository changes the dependency source, not app imports or build configuration.
The tests are the conformance suite: `shell-argv`, `shell-scope`, `shell-harm`, and
`command-routing` tests live here; the tests for the app's environment binding and
for the prompt copy stay in the app.
