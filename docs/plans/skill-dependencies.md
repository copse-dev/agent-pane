# Bounded workflow skill dependencies

Initial task base: `2b25d75dae6e191934890666759fc7919584407c`.
Rebased onto `41b7c785ff978c66a303874b4c3cfde00fe6e2a5` before handoff.

Problem: explicitly invoking a workflow does not let it load manual-only leaf skills.
Acceptance: an invoked root loads a declared manual-only leaf and its supporting file;
undeclared, disabled and replaced dependencies fail; cycles, repeated reads, cancellation
and concurrent count/context spending stay bounded; direct invocation still works.

Scope: native parent activation policy, definition parsing and prompt/tool guidance.
Child/ACP execution-context transport, per-child budgets, workflow redesign and vendor
snapshots are separate work. No shell/read-root, tool permission or trust escalation.
Validation: focused parser/activation tests, native mock tool/transcript visual evidence,
oracle and full check (authorization/control-flow change).

## Authoring contract

Add `copse-dependencies: [leaf-name, helper-name]` to SKILL.md YAML frontmatter.
Only explicit user invocation starts dependency authority. Textual mentions, model selection,
`allowed-tools`, and descriptions do not. Each declaration is a list of at most sixteen strict
skill names; duplicates collapse. An absent declaration grants nothing.

A name resolves to the existing registry winner only when its source, plugin identity
(including absence), and immediate skill container match the declaring skill. Canonical
sibling containment is checked on loading. Registry precedence remains unchanged: a higher
precedence override cannot silently replace a declared sibling and there is no fallback to
a shadowed definition. Cross-plugin, cross-container and cross-source composition is unsupported.
Disabled or missing entries remain unavailable, with registry diagnostics retained.

Declarations and identities are captured for the parent run and validated against current
files before use; changed declarations require discovery reload. A successfully loaded
dependency can declare further sibling dependencies. The host never recursively auto-loads
a graph. Cycles therefore converge on already injected identities, and a failed activation
does not grant its descendants. Supporting files require successful activation first.

There are sixteen dependency activation slots in addition to the existing four ordinary
model activation slots. All injected skill text and supporting reads share the existing
128 KiB UTF-8 context budget, including the explicit invocation prompt. Slots reserve
synchronously before loading; byte charges commit synchronously after loading. Failed or
aborted loads release their slot and grant no descendants. Instruction aliases deduplicate;
repeated supporting reads spend context again and eventually fail at the same byte cap.

Dependencies keep their own source trust, are subordinate to the user and invoked root,
and receive no run_shell read roots or other permissions. Explicit invocation preserves its
existing behavior. This policy is model-independent host enforcement; deterministic tests
do not establish that every model will choose the right dependencies.

## Availability and integration

`getSkillAvailability(name)` reports `supported`, `disabled`, or `unavailable` for
preflight diagnostics; it grants no invocation authority. Live global, bundled-plugin
and registered user-plugin switches govern reads even inside a frozen run catalog.
A qualified disabled-plugin request can be identified after discovery prunes that
plugin; an unknown bare leaf has no provenance and remains `unavailable`.

The activation API is unchanged. Child and ACP execution-context transport and allowance
ownership remain in the separate child/ACP task. A child with no explicit invocations
receives no inherited dependency authority. Existing bundled workflows require native
declarations before they can use this contract; no vendor files were modified.

## Validation — 2026-10-21

- `pnpm test -- skill-activation parse-skill-frontmatter skill-prompt skills-registry read-skill-tool`:
  109 passed, 0 failed. Covers declaration parsing, source/container/plugin identity,
  live disable, supporting files, cycles/diamonds, concurrent count/context limits,
  cancellation, failed parallel loads/retry and unchanged direct invocation.
- `pnpm run typecheck`: all four Node, renderer, E2E and demo projects passed.
- Focused type-aware ESLint on the final activation implementation, tests and E2E spec passed.
- `pnpm run build` passed. `pnpm run test:e2e -- --spec tests/e2e/skill-workflow-dependencies.e2e.ts`:
  1 passed. The native executor loads a declared manual-only leaf and its supporting file,
  rejects an undeclared leaf, and renders attribution/trust/error text. Inspected
  `skill-workflow-dependency.png`: readable attribution and source, normal wrapping,
  no overlap; only the host temp prefix is masked. This is mock selection evidence,
  not a real-model reliability claim or a CI Linux baseline acceptance.
- `pnpm run oracle -- --explain`: HIGH, all changes mapped to tests.
- `pnpm run check` on the rebased change passed every static gate, then reported
  15,399 passed / 18 failed / 4 skipped. The final activation-waiter identity hardening
  and parallel-failure regression were checked afterward with the focused 109-test
  suite, typecheck, lint, build and native visual run; the broad unit tier was not
  repeated for that final hardening.

The 18 full-suite failures remain outside this task: Bash 3 array handling (1),
screenshot-review rejection of macOS `/var` (6), a small-gate test assuming an empty
checkout (1), Git signing environment (2), Python/uv/pip versions (2), LibreSSL error
wording (1), OpenSSH socket path length (4), and installed Cargo detection (1).
A targeted rerun of those modules on the clean initial base reproduced 16 identical
failures and an additional Cargo execution-environment failure. The remaining two
cases are the dirty-checkout assumption and Cargo detection, not changes to those
modules. The full gate is **not green**; these observations do not establish all-model
compatibility or validate the separately owned child/ACP integration.

Raw logs and the inspected PNG are retained locally under
`.tmp/skill-dependencies-evidence/` in the isolated task worktree. No local PNG is
committed as a reference; CI screenshot review remains outstanding if a PR is opened.
