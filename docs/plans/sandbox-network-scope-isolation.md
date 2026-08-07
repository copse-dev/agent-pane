# Sandbox network scope isolation

**Status: Phases 1–3 implemented; 4–5 proposed.** Written after a user report of
constant "Run shell command?" prompts in a pane running an OpenRouter model,
where the reason line named a network widening the pane had nothing to do with.

Phases 1–3 (probe teardown, scope labelling, capability-based gating) shipped
together and are marked inline below. Phase 4 (moving background probes to their
own process) and Phase 5 are unstarted — they are the parts that depend on the
ASRT audit's conclusion, and Phase 3 should be given time to show how much
residual prompting is left before paying for them.

## The symptom

A pane running a non-ACP model (OpenRouter) prompts for every shell command,
including ones that open no sockets:

```
Run shell command?
  sed -n '130,200p' tests/e2e/roadmap-done-toggle.e2e.ts
  Reason: sandbox network access is temporarily widened for another process
```

That reason comes from the overlap gate at the top of
`ensureShellCommandPermitted` (`security/permission-gate.ts:725`):

```ts
if (!guardedYolo && isSandboxNetworkScopeActive() && !shareActiveNetworkScope) {
  return promptShell(command, ['sandbox network access is temporarily widened…'], …)
}
```

It returns before the trusted-command fast path (`:741`), before
`decideShellPermission` (`:767`), and before the auto-approval classifier. No
analysis of the command happens at all, so `ls`, `cat`, and `pwd` are gated
identically. The native `run_shell` path never opts into sharing:
`checkShellPermission` (`:650`) passes no `networkScopeAlreadyApplies`, and the
ACP bridge ALS is empty outside a bridge call — correctly, since the widening
does not belong to that pane.

## Why the gate has to be this blunt today

`acquireSandboxNetworkScope` writes to process-global state
(`project-sandbox/network-scope.ts:51-57`):

```ts
SandboxManager.updateConfig({ ...config, network: mergedScopeNetwork([...activeScopes]) })
```

`mergedScopeNetwork` unions every active scope. A command spawned through
`workspaceSandboxOverlay(cwd)` carries `network: containedSandboxNetworkConfig()`
(`allowedDomains: []`), but that block only selects _whether_ restriction is
wired up — the proxies decide allow/deny against the global config. So during a
widening, an unrelated command really does run with the widened allowlist, and
ASRT cannot attribute a connection to a process. Suspending auto-run for the
duration is the only lever the current API offers.

## Who holds a scope

Exactly two callers:

| caller                           | trigger                                                | lifetime                    |
| -------------------------------- | ------------------------------------------------------ | --------------------------- |
| `project-sandbox/spawn.ts:308`   | background task with `allow_port_binding` (dev server) | until the process exits     |
| `services/acp/acp-client.ts:287` | any sandboxed ACP agent process                        | pooled session, 10 min idle |

The second includes work no one initiated. `workspace:set` fires
`revalidateStaleAcpModels()` (`ipc/register-handlers.ts:513`), which re-probes
every **enabled** ACP agent whose model cache is older than `ACP_MODELS_TTL_MS`
(24h, `acp-auto-setup.ts`). All five `KNOWN_ACP_AGENTS` carry `sandbox` presets,
so each probe takes a scope. Opening a folder is enough; the user need never have
selected an ACP agent in a pane.

### Suspected leak

The release is bound to two events (`acp-client.ts:306-307`):

```ts
child.once('close', release)
child.once('error', release)
```

Probe teardown is a bare `child.kill()` (`:934` timeout, `:952` finally) against
the sandbox wrapper shell, which is spawned without `detached` (`:301-305`) and
never goes through `terminateProcessTree`. Compare `spawn.ts:322-329`, which does
pass `detached: detachForGroupKill`. If the real agent survives as a grandchild
holding the inherited stdio pipes, `'close'` never fires, `release` is never
called, and `isSandboxNetworkScopeActive()` stays true for the rest of the app
run — every pane prompting on every command, attributed to a process that has
already exited.

Unproven: whether `sh -c` execs the agent (making the current kill land) depends
on the wrapped command shape. The binding is fragile either way.

### No way to see any of this

`activeScopes` is an anonymous `Set<SandboxNetworkScope>`, nothing logs acquire
or release, and the prompt says "another process" because nothing knows which
one. The report that prompted this plan was undiagnosable from the UI.

## What ASRT actually allows

Audited against `@anthropic-ai/sandbox-runtime@0.0.67` (the pinned version).
This settles whether the fix can be per-spawn or has to be per-process.

1. **One instance per process.** `export const SandboxManager = { … }`
   (`dist/sandbox/sandbox-manager.js:1666`) is an object literal closing over
   module-level `let config` (`:28`) and `let proxyAuthToken` (`:42`).
   `ISandboxManager` declares no constructor and the package exports no class or
   factory. Multiple in-process sandboxes are not available.

2. **No per-spawn network policy.** On both platform branches
   (`:1110` POSIX, `:1230` Windows), `customConfig.network.allowedDomains` is
   consumed only as a boolean `hasNetworkConfig`. ASRT states the intent
   directly (`:1116`):

   > Even with empty allowedDomains, we route through proxy so that:
   >
   > 1. `updateConfig()` can enable network access for already-running processes
   > 2. The proxy blocks all requests when allowlist is empty

   The per-spawn overlay picks _whether_ to restrict; the global config picks
   _what is allowed_. The `network-scope.ts` docblock is accurate.

3. **No attribution hook.** `SandboxAskCallback` receives `{ host, port }`.
   `FilterRequestCallback` (`dist/sandbox/request-filter.d.ts`) receives a
   web-standard `Request` — method, URL, headers, body — with no PID or source
   socket. `proxyAuthToken` is one value minted once at `initialize` (`:542`) and
   handed to every wrapped child, so children are indistinguishable by
   credential.

4. **Nesting is a degraded mode.** `enableWeakerNestedSandbox` exists
   (`sandbox-config.js:842`, gated at `linux-sandbox-utils.js:1237`), so a helper
   that owns its own ASRT should be spawned unsandboxed from the host rather than
   nested inside the main sandbox.

5. **One escape hatch, unevaluated.** `config.network.httpProxyPort` /
   `socksProxyPort` accept an **external** proxy the app owns ("the auth token is
   only set when this process owns the proxy; an external proxy handles its own
   auth"). A self-hosted proxy could in principle map a client socket back to a
   PID. Not evaluated: macOS seatbelt (shared netns) and Linux (bwrap
   `--unshare-net` + socat bridge) present very different source-identity
   stories. Recorded as an option; nothing below depends on it.

**Conclusion: separate network policy requires separate processes.** There is no
cheaper per-spawn route.

## Plan

Phases 1–3 are independent of each other and of the architecture question.

### Phase 1 — Stop the leak (implemented)

- Replace the bare `child.kill()` in `probeAcpAgent` (`:934`, `:952`) and the
  session transport's `dispose` (`:564`) with `terminateProcessTree`
  (`services/exec/subprocess-kill.ts`, already used by `sandbox-fs-server.ts`).
- Spawn the ACP wrapper with `detached` so the group kill has a group to target,
  mirroring `spawn.ts:322-329`.
- Bind `release` to `'exit'` as well as `'close'`, so a surviving grandchild
  holding the pipes cannot pin the scope.
- Regression test: a probe whose agent forks a child that outlives SIGTERM must
  still release its scope.

Built as described. `terminateAcpChild` in `acp-client.ts` wraps
`terminateProcessTree` and cancels its SIGKILL escalation on close, replacing all
five bare `child.kill()` sites; both spawn paths now pass
`detached: detachForGroupKill` (newly exported from `project-sandbox/spawn.ts`),
and `release` is bound to `exit`, `close`, and `error`.

### Phase 2 — Make it observable (implemented)

- Add a `label` to `SandboxNetworkScope` (`acp-probe:codex`,
  `background:npm run dev`).
- Log acquire and release with the label and the resulting union size.
- Export the active labels and put them in the prompt reason: "sandbox network
  access is widened for: codex model probe" instead of "another process".

This is what makes the next occurrence self-diagnosing, and it should land before
Phase 4 so the improvement is measurable.

Built as described. `SandboxNetworkScope.label` is required rather than optional,
so a new holder cannot be added anonymously; `activeSandboxNetworkScopeLabels()`
deduplicates and the gate interpolates it into the prompt reason.

### Phase 3 — Gate on capability, not the clock (implemented)

A command that cannot open a socket cannot reach the widened allowlist, so the
overlap is not a reason to prompt it.

- Start conservative: let the gate pass anything
  `isStructurallyReadOnlyShellCommand` already accepts. Strictly safe, since that
  predicate is the one the codebase already trusts for this shape.
- That does **not** fix `sed`, which is absent from `READ_ONLY_SHELL_BASENAMES`
  (`shell-argv.ts:157`); `awk` is additionally in `NON_TRUSTABLE_COMMANDS`
  (`command-routing.ts:102`). Extending to them is a separate decision and needs
  script-shape analysis, not a basename add: `sed -i`, `sed -n 'w out'`, GNU
  `sed`'s `e`, `awk`'s `system()`, `print > file`, and `|& "cmd"` all write or
  execute.
- Honest limit: a read-only command still _runs_ during the widened window. The
  argument is that it opens no sockets, not that it is harmless.

Built as the conservative option: the gate now also requires
`!isStructurallyReadOnlyShellCommand(command)`. `sed` still prompts during a
widening, exactly as this section predicted — the reported command is not fixed
by this phase, only the `cat`/`rg`/`git status` class around it.

### Phase 4 — Move background probes out of process

Probes are the largest and least explicable source of scope activation: seconds
long, no user-visible turn, egress needed to exactly one vendor.

- Run each probe in a helper process that calls its own
  `SandboxManager.initialize()`. Its allowlist never touches the main process's
  global config, so no other pane observes it.
- Precedent and plumbing exist: `sandbox-fs-server.ts` is a long-lived
  seatbelt-wrapped worker with its own overlay (`fsServerSandboxOverlay`) and a
  `terminateProcessTree` teardown.
- Per finding 4, spawn the helper unsandboxed from the host and let it own its
  ASRT — do not nest it inside the main sandbox.
- Cost: one extra process and one proxy start-up per probe. Probes already carry
  a 15s budget, so this is affordable there; measure before extending the pattern
  to long-lived sessions.
- Independently worth doing: stop `revalidateStaleAcpModels()` firing on every
  `workspace:set` for agents the user has never selected in a pane.

### Phase 5 — Long-lived ACP sessions (deferred)

Reassess after Phase 4. If a pooled session still pins the global allowlist
across 10 idle minutes, give it a host process too — same mechanism, higher cost.

**Per-thread network sandboxes are not recommended.** Every thread's shell policy
is already deny-all and identical; threads differ in filesystem root, which
`workspaceSandboxOverlay(cwd)` already handles correctly per spawn — and
per-spawn _filesystem_ is the axis ASRT does honor. The variance that justifies
isolation is per-agent, not per-thread.

## Not recommended

- **Multiple `SandboxManager`s in the main process** — the API does not expose a
  constructor (finding 1).
- **A global `filterRequest` for attribution** — the callback cannot see who is
  asking (finding 3).
- **Removing the overlap gate** — the widening is real. Phase 3 narrows it by
  capability; it should not be deleted.

## Open questions

- Reproduce the Phase 1 leak empirically first: does the wrapper `sh -c` exec the
  agent, making the current kill land? The fix is worth doing either way, but the
  answer decides whether it explains this report.
- Should Phase 3's predicate be a new "cannot reach the network" check or an
  extension of the read-only one? A network-capability check is the honest shape,
  but it duplicates analysis the read-only path already does.
