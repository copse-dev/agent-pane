# Command sandboxing routing

**Status:** wired end-to-end (routing core + gate + spawn + Settings UI). A real
`container` backend is the remaining follow-up.

## Motivation

Today a shell command gets one of two fates (`src/main/services/security/permission-policy.ts` → `decideShellPermission`), derived from a 3-way heuristic verdict in `shell-scope.ts`:

- **auto-run inside the seatbelt** (`sandbox` / `ambiguous` verdict), or
- **prompt, then run fully unsandboxed** (`external` verdict).

That binary is coarse in two directions:

1. **Not tight enough.** Every auto-run command gets the same workspace-**write** overlay, even a pure `ls`/`cat` that needs no write capability at all.
2. **Not permissive enough where it should be.** Some commands genuinely _cannot_ be sandboxed (they need the host toolchain, code-signing, or vendor endpoints — `xcodebuild` is the canonical example) yet are entirely safe for a given project. Under the binary model those hit `external` every time and prompt on every invocation — pure prompt fatigue, which trains users to disable the gate (violating design principle #3 in `docs/threat-model.md`).

This feature introduces **routing tiers** and **per-segment decomposition** so a command runs in the _minimal context that actually satisfies it_, and a narrow user-trusted set runs with **no prompt at all**.

## Tier model

`src/main/services/security/command-routing.ts` defines:

| Tier        | Isolation                              | Network | Prompt? | Realized by                                    |
| ----------- | -------------------------------------- | ------- | ------- | ---------------------------------------------- |
| `read`      | seatbelt, FS **read-only**             | denied  | no      | `readonlySandboxOverlay` (new, in `config.ts`) |
| `write`     | seatbelt, workspace read+write         | denied  | no      | `workspaceSandboxOverlay` (today's default)    |
| `container` | stronger host isolation (VM/container) | policy  | no      | _no backend yet — see below_                   |
| `allow`     | **unsandboxed**                        | full    | **no**  | direct spawn, `unsandboxed: true`              |
| `prompt`    | —                                      | —       | **yes** | existing approval gate                         |

`read ⊂ write ⊂ container` is a nesting of capability inside a confined context; `allow` is the escape hatch for the unsandboxable-but-safe set; `prompt` is the fallback for anything unknown/external/destructive.

### The `container` tier

`@anthropic-ai/sandbox-runtime` gives us a macOS seatbelt only — there is no cross-platform container/VM backend in the app today. So v1 **models** the tier (it exists in the enum, the routing table, and the join lattice) but has no runner. The wiring layer will map a resolved `container` context to the strongest available sandbox (seatbelt) or fall back to a prompt, with a `TODO` for a real backend (Linux: bubblewrap/nsjail or Docker; macOS: Apple `container` / a microVM). Modelling it now keeps the config format and types forward-compatible.

## Routing table

A per-command map of _command head_ → tier, merged from built-in defaults and a per-project user setting (`buildRoutingTable`).

- **Defaults** (`DEFAULT_COMMAND_ROUTES`) seed `read` for pure inspectors (`ls`, `cat`, `pwd`, …) and `write` for workspace mutators (`mkdir`, `touch`, `cp`, `mv`, `tee`).
- **`allow` ships empty.** Unsandboxed-no-prompt is a real per-project trust grant, so the user opts in (Settings, or a "remember" on the escalation prompt) — e.g. add `xcodebuild` for an iOS project.
- Commands whose safety depends on their subcommand are deliberately **absent** (`git` is left to the analyzer's network-subcommand detection).

Lookups are by **basename**: env assignments (`FOO=bar cmd`), transparent wrappers (`env`, `nohup`, `nice`, …), and paths (`/usr/bin/xcodebuild` → `xcodebuild`) are stripped in `commandHead`.

## Decomposition + resolution

`resolveCommandRouting(command, workspaceRoot, table)`:

1. **Whole-command gates first, never bypassed:**
   - command substitution (`$(…)` / backticks) → `prompt` (hidden tools),
   - `dangerousInSandboxReasons` (`rm -rf`, fork bombs, pipe-to-interpreter, …) → `prompt`.
     These run on the _whole_ string so cross-segment tricks like `cat payload.sh | sh` — which per-segment analysis would miss — are caught.
2. **Split** into top-level segments at `&&`/`||`/`;`/`|`/`&`/newline, quote-aware (`splitSegments`).
3. **Route each segment** (`resolveSegmentTier`): an `allow`-listed head waives the network/outside-path heuristic _for that segment only_; every other segment is classified by `analyzeShellCommand` (external → `prompt`), then by its table entry, else defaults to `write` (contained).
4. **Join** (`joinTiers`) to the single context that satisfies all segments:
   - any `prompt` → `prompt`;
   - `allow` + `container` are incompatible → `prompt`;
   - else most-permissive-required: `allow` > `container` > `write` > `read`.

### Flagship example

```
mkdir -p build && xcodebuild -scheme App -derivedDataPath build
```

- `mkdir -p build` → `write` (workspace mutator, no escape),
- `xcodebuild …` → `allow` (user-trusted, unsandboxable),
- `join(write, allow)` = **`allow`** → the whole line runs unsandboxed with **no prompt**.

The `mkdir` write lands on real disk (the sandbox writes through), so the subsequent unsandboxed `xcodebuild` sees `build/`. Prep happens in the safe context; the trusted tool runs in its required context; the user is never interrupted.

## Security argument

This is a **UX/routing refinement, not a new boundary** (defense-in-depth, principle #2). The guarantees:

- The **destructive** and **command-substitution** gates are whole-command and are never waived — not even for an allow-listed head. `xcodebuild build && rm -rf ~` and `xcodebuild $(cat sneaky)` both prompt.
- `allow` only waives the _network/outside-path_ heuristic, and only for the **specific allow-listed command token** — a co-segment `curl`/`git push` still classifies `external` → `prompt`, so the compound prompts.
- A command runs unsandboxed **only** when _every_ segment is either explicitly allow-listed or statically sandbox-safe. Allow-listing `xcodebuild` never launders an arbitrary co-process into unsandboxed execution.
- `read` uses the OS seatbelt (not just static analysis) to enforce no-write, so a misrouted or misbehaving "read-only" command is contained by the kernel.

The routing table is trusted config: it lives in the user's own settings, never in the workspace, so a cloned repo cannot add an `allow` entry (same trust model as custom tools).

## How it's wired

The routing core (`command-routing.ts`) is pure; two call sites resolve the same
command through `routeShellCommand` (settings + workspace root), so the gate and
the tool never drift:

1. **Setting** `commandRoutingTable: CommandRoute[]` — persisted per project,
   validated by `commandRoutingTableSchema`, read via `loadCommandRoutes`.
2. **Gate** (`permission-gate.ts` → `checkShellPermission`): a **complete-allow
   fast path** returns `true` (no prompt) when the command resolves to the `allow`
   tier, gated behind the global auto-run toggle. Every other command falls
   through to the existing `decideShellPermission` unchanged — routing is purely
   additive, so no command that auto-runs today starts prompting.
3. **Spawn** (`shell-tool.ts` → `spawnShellInProjectSandbox`): the tool maps the
   tier to execution — `allow` → `unsandboxed: true`, `read` → `readonlySandboxOverlay`,
   `write`/`container` → the default workspace overlay (container is the stub).
   `read` is only applied when a segment provably cannot write (a `>` redirect
   bumps it back to `write`), so the tightening never breaks a redirecting command.
4. **Settings UI** (`settings-dialog.ts`): a "Command routing" fieldset under
   Local models → a `command:tier`-per-line textarea, parsed/formatted by the
   shared `parseCommandRoutes`/`formatCommandRoutes`.

### Remaining follow-ups

- A real `container` backend (Linux: bubblewrap/nsjail/Docker; macOS: Apple
  `container`/microVM). Today `container` maps to the workspace seatbelt.
- Offer "always allow → add to table" on the escalation prompt (prompt-once → add
  an `allow` rule) for even less friction.
- Surface the chosen tier + per-segment reasons in the shell-output banner
  (observability, principle #4).

## Files

- `src/shared/command-routing.ts` — pure types + `command:tier` text format (renderer-safe).
- `src/main/services/security/command-routing.ts` — tier model, table, decomposition, resolution.
- `src/main/services/security/command-routing-config.ts` — settings-backed `routeShellCommand`.
- `src/main/services/security/command-routing.test.ts`, `src/shared/command-routing.test.ts` — unit tests.
- `src/main/project-sandbox/config.ts` — `readonlySandboxOverlay` for the `read` tier.
- `src/main/tools/shell-tool.ts`, `src/main/project-sandbox/spawn.ts` — tier → overlay execution.
- `src/main/services/security/permission-gate.ts` — complete-allow fast path.
- `src/renderer/views/settings-dialog.ts`, `src/preload/*`, `settings-writable.ts` — setting + UI.
