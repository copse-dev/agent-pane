# Command sandboxing routing

**Status:** design + routing core landed; live wiring is a follow-up.

## Motivation

Today a shell command gets one of two fates (`src/main/services/security/permission-policy.ts` → `decideShellPermission`), derived from a 3-way heuristic verdict in `shell-scope.ts`:

- **auto-run inside the seatbelt** (`sandbox` / `ambiguous` verdict), or
- **prompt, then run fully unsandboxed** (`external` verdict).

That binary is coarse in two directions:

1. **Not tight enough.** Every auto-run command gets the same workspace-**write** overlay, even a pure `ls`/`cat` that needs no write capability at all.
2. **Not permissive enough where it should be.** Some commands genuinely *cannot* be sandboxed (they need the host toolchain, code-signing, or vendor endpoints — `xcodebuild` is the canonical example) yet are entirely safe for a given project. Under the binary model those hit `external` every time and prompt on every invocation — pure prompt fatigue, which trains users to disable the gate (violating design principle #3 in `docs/threat-model.md`).

This feature introduces **routing tiers** and **per-segment decomposition** so a command runs in the *minimal context that actually satisfies it*, and a narrow user-trusted set runs with **no prompt at all**.

## Tier model

`src/main/services/security/command-routing.ts` defines:

| Tier | Isolation | Network | Prompt? | Realized by |
| --- | --- | --- | --- | --- |
| `read` | seatbelt, FS **read-only** | denied | no | `readonlySandboxOverlay` (new, in `config.ts`) |
| `write` | seatbelt, workspace read+write | denied | no | `workspaceSandboxOverlay` (today's default) |
| `container` | stronger host isolation (VM/container) | policy | no | *no backend yet — see below* |
| `allow` | **unsandboxed** | full | **no** | direct spawn, `unsandboxed: true` |
| `prompt` | — | — | **yes** | existing approval gate |

`read ⊂ write ⊂ container` is a nesting of capability inside a confined context; `allow` is the escape hatch for the unsandboxable-but-safe set; `prompt` is the fallback for anything unknown/external/destructive.

### The `container` tier

`@anthropic-ai/sandbox-runtime` gives us a macOS seatbelt only — there is no cross-platform container/VM backend in the app today. So v1 **models** the tier (it exists in the enum, the routing table, and the join lattice) but has no runner. The wiring layer will map a resolved `container` context to the strongest available sandbox (seatbelt) or fall back to a prompt, with a `TODO` for a real backend (Linux: bubblewrap/nsjail or Docker; macOS: Apple `container` / a microVM). Modelling it now keeps the config format and types forward-compatible.

## Routing table

A per-command map of *command head* → tier, merged from built-in defaults and a per-project user setting (`buildRoutingTable`).

- **Defaults** (`DEFAULT_COMMAND_ROUTES`) seed `read` for pure inspectors (`ls`, `cat`, `pwd`, …) and `write` for workspace mutators (`mkdir`, `touch`, `cp`, `mv`, `tee`).
- **`allow` ships empty.** Unsandboxed-no-prompt is a real per-project trust grant, so the user opts in (Settings, or a "remember" on the escalation prompt) — e.g. add `xcodebuild` for an iOS project.
- Commands whose safety depends on their subcommand are deliberately **absent** (`git` is left to the analyzer's network-subcommand detection).

Lookups are by **basename**: env assignments (`FOO=bar cmd`), transparent wrappers (`env`, `nohup`, `nice`, …), and paths (`/usr/bin/xcodebuild` → `xcodebuild`) are stripped in `commandHead`.

## Decomposition + resolution

`resolveCommandRouting(command, workspaceRoot, table)`:

1. **Whole-command gates first, never bypassed:**
   - command substitution (`$(…)` / backticks) → `prompt` (hidden tools),
   - `dangerousInSandboxReasons` (`rm -rf`, fork bombs, pipe-to-interpreter, …) → `prompt`.
   These run on the *whole* string so cross-segment tricks like `cat payload.sh | sh` — which per-segment analysis would miss — are caught.
2. **Split** into top-level segments at `&&`/`||`/`;`/`|`/`&`/newline, quote-aware (`splitSegments`).
3. **Route each segment** (`resolveSegmentTier`): an `allow`-listed head waives the network/outside-path heuristic *for that segment only*; every other segment is classified by `analyzeShellCommand` (external → `prompt`), then by its table entry, else defaults to `write` (contained).
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
- `allow` only waives the *network/outside-path* heuristic, and only for the **specific allow-listed command token** — a co-segment `curl`/`git push` still classifies `external` → `prompt`, so the compound prompts.
- A command runs unsandboxed **only** when *every* segment is either explicitly allow-listed or statically sandbox-safe. Allow-listing `xcodebuild` never launders an arbitrary co-process into unsandboxed execution.
- `read` uses the OS seatbelt (not just static analysis) to enforce no-write, so a misrouted or misbehaving "read-only" command is contained by the kernel.

The routing table is trusted config: it lives in the user's own settings, never in the workspace, so a cloned repo cannot add an `allow` entry (same trust model as custom tools).

## Wiring plan (follow-up)

The routing core is pure and unwired — no behavior change yet. To make it live:

1. **Setting** `commandRoutingTable: CommandRoute[]` (per project), read in `checkShellPermission`.
2. **Gate** (`permission-gate.ts`): replace the `decideShellPermission` call with `resolveCommandRouting`; `outcome: 'prompt'` keeps today's approval UI (now able to offer "always allow → add to table" for prompt-once). `outcome: 'run'` carries the tier.
3. **Spawn** (`project-sandbox/spawn.ts` / `shell-tool.ts`): map tier → overlay — `read` → `readonlySandboxOverlay`, `write` → `workspaceSandboxOverlay`, `container` → strongest-available (stub), `allow` → `unsandboxed: true`.
4. **Settings UI** section to view/edit the table and see each command's resolved tier.
5. **Observability**: surface the chosen tier + per-segment reasons in the shell-output banner (principle #4).

## Files

- `src/main/services/security/command-routing.ts` — pure tier model, table, decomposition, resolution.
- `src/main/services/security/command-routing.test.ts` — 23 unit tests.
- `src/main/project-sandbox/config.ts` — `readonlySandboxOverlay` for the `read` tier.
