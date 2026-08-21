# Locked ACP adapter installs

**Status: Proposed.** Replace the floating, host-wide `npm install -g` that
auto-setup uses to obtain external ACP adapters with a **committed lockfile** and
an **app-owned install tree**, installed with `npm ci` and verified before use.
Removes the app's dependency on the user's `node`/`npm`, gives us tarball
integrity we do not have today, and stops Copse mutating the user's global npm
prefix.

Scoped to the adapter packages Copse installs on the user's behalf. It does not
bundle third-party binaries into the `.app`, and it does not take ownership of
the underlying agent clients (`claude`, `cursor-agent`, `gemini`) — see
[Non-goals](#non-goals).

## Problem

[`installGlobalNpmPackage`](../../src/main/services/security/socket-firewall.ts)
runs `npm install -g --ignore-scripts <pkg>` through Socket Firewall against
**the user's npm**, resolving whatever the `latest` dist-tag points at when the
command runs. Four consequences:

1. **No integrity guarantee.** We resolve a dist-tag and execute what the
   registry returns. Nothing pins a tarball hash. A compromised or
   mistakenly-published version is installed and spawned with no check.
   `docs/supply-chain-security.md` already names this class of gap in Phase 3
   ("Discourage `npx -y`/`uvx` latest-fetch … recommend pinned versions"); the
   ACP adapter path is the same gap on a different surface.
2. **Non-reproducible.** Two machines that ran auto-setup a week apart run
   different adapter versions, and neither is recorded anywhere. Bug reports
   cannot be tied to an adapter revision.
3. **We mutate the user's machine.** The install lands in their global prefix.
   [`acp-adapter-version.ts`](../../src/main/services/acp/acp-adapter-version.ts)
   exists largely to cope with the fallout — resolving "the npm beside the
   resolved binary" so nvm/fnm prefixes stay consistent, then asking the registry
   for `latest` on a one-hour TTL to decide whether to offer an upgrade. All of
   that is bookkeeping for state we do not own.
4. **The user's `node` is a silent prerequisite.** Adapters are npm bins with a
   `#!/usr/bin/env node` shebang, and
   [`acp-client.ts`](../../src/main/services/acp/acp-client.ts) spawns
   `config.command` from `PATH`. A user with no Node install cannot run any npm
   adapter, and the failure surfaces as a spawn error rather than a diagnosis.

## Prior art: block/berd

Berd (Tauri + `goose serve`) solves the same problem with `acp-tools.lock.json`
plus `src-tauri/src/services/managed_acp_tools.rs`. Worth being precise about
what it does, because it is often described as bundling:

- The lock commits a full `package.json` **and** `package-lock` per bridge. The
  installer stages that tree and replays it with `npm ci`, so npm resolves _to_
  the pin and rejects any tarball whose integrity differs.
- It records `nativeExecutables` — the per-target path of the platform binary
  that must physically exist before an upgrade is allowed to commit.
- A startup reconciler makes the on-disk tree match the lock.
- **The install happens at runtime, not at build time.** Nothing but the lock
  ships in the app. No nested third-party Mach-O to sign, and moving a pin does
  not require an app binary release.
- Because Rust has no JS runtime, berd must also ship one: `node-runtime.lock.json`
  - `managed_node.rs`.

We inherit the first four and skip the fifth: Copse already spawns work under
Electron's Node in eight places (`ELECTRON_RUN_AS_NODE=1 process.execPath` — see
[`acp-session-host.ts`](../../src/main/services/acp/acp-session-host.ts)), and
[`electronRuntimeAllowReadPaths`](../../src/main/project-sandbox/config.ts)
already grants that runtime inside the seatbelt for the sandbox-fs worker.

Berd's own lockfile comment records the design's cost honestly, and it applies to
us unchanged: _"transitive security patches arrive only when someone regenerates
this file: it needs an owner and a refresh cadence."_

## Scope

In scope — the npm-distributed adapters in
[`acp-known-agents.ts`](../../src/shared/acp-known-agents.ts):

| id                 | package                                 | today                            |
| ------------------ | --------------------------------------- | -------------------------------- |
| `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` | `autoInstall`, gated on `claude` |
| `codex-acp`        | `@agentclientprotocol/codex-acp`        | `autoInstall`, standalone        |

`gemini-cli` can join by gaining an `installPackage`; it is a plain npm package
today with only an `install` string.

**`claude-code-acp` is deliberately absent** — it should be retired from the
catalog before this lands, not locked. npm marks
`@zed-industries/claude-code-acp` deprecated with the message "This package has
been renamed to @agentclientprotocol/claude-agent-acp. Please migrate to continue
receiving updates." It stopped at `0.16.2` on 2026-02-17; the renamed package
starts at `0.24.0` on 2026-03-26 and is at `0.70.0`. Our catalog is carrying the
dead predecessor of an adapter we already ship, with a near-identical duplicated
sandbox profile. See [Consolidating the Claude adapters](#consolidating-the-claude-adapters).

### Non-goals

- **`cursor-agent`.** Distributed by `curl … | bash`; auto-setup already refuses
  to install it and Socket Firewall cannot wrap it. Unchanged by this plan.
- **The agent clients themselves — but only where the adapter does not already
  carry one.** This differs per adapter and the difference matters:
  - **`claude-agent-acp` pins its client transitively.** `0.70.0` declares an
    exact dependency on `@anthropic-ai/claude-agent-sdk@0.3.232`, whose eight
    platform `optionalDependencies` each ship a `claude` binary. Installing the
    adapter from the lock therefore installs a pinned, integrity-checked client
    too — which is why berd's lock names
    `node_modules/@anthropic-ai/claude-agent-sdk-<target>/claude` as the
    `nativeExecutables` path to verify. If the adapter executes that bundled
    binary rather than a `PATH` one, `requiresClient: 'claude'` becomes
    unnecessary for a lock-installed tree and the user no longer needs their own
    Claude Code install. **Verify which binary it actually spawns before relying
    on this**; authentication stays user-managed either way, since the binary
    reads the user's stored credentials.
  - **`cursor-agent` and `gemini` do not.** For those the wrapper is genuinely
    just a wrapper, the client stays whatever the user installed, and the
    residual gap is real. Say so in the Settings copy rather than implying
    otherwise.
- **Build-time bundling into the `.app`.** Every nested Mach-O would need our
  certificate, hardened runtime and an `asarUnpack` entry (we already carry that
  cost for `node-pty`, `@anthropic-ai/sandbox-runtime` and gortex — see
  `docs/releasing-macos.md`), agent fixes would wait for a Copse release, and
  redistributing vendor binaries is a licensing question per vendor. Left as a
  later option in [Phasing](#phasing) for any adapter we clear.
- **A self-hosted registry or mirror.** The lock buys integrity; a mirror buys
  availability and a review gate on transitive bumps, at the cost of registry
  infrastructure and the same staleness problem. Revisit only if we need offline
  installs.

## Discovery: the ACP registry

The [ACP registry](https://github.com/agentclientprotocol/registry) publishes a
machine-readable index at
`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
(38 agents as of 2026-08-20). It is the right basis for **what adapters exist and
how they are distributed**, and the wrong basis for **which version we ship**.
Those two roles must not be collapsed.

### What it supplies

Per agent: `id`, `name`, `description`, `repository`, `website`, `authors`,
`license`, `icon`, `version`, and a `distribution` block in one of three shapes —
`npx` (`package@version` plus `args`), `uvx`, or `binary` (per-target `archive`
URL, `cmd`, `args`, and sometimes `sha256`).

All four agents in our catalog are listed:

| ours               | registry id  | registry distribution                                 |
| ------------------ | ------------ | ----------------------------------------------------- |
| `claude-agent-acp` | `claude-acp` | `npx @agentclientprotocol/claude-agent-acp@<pinned>`  |
| `codex`            | `codex-acp`  | `npx @agentclientprotocol/codex-acp@<pinned>`         |
| `gemini-cli`       | `gemini`     | `npx @google/gemini-cli@<pinned>` args `["--acp"]`    |
| `cursor`           | `cursor`     | `binary`, per-target archive + `cmd` + `args ["acp"]` |

Two immediate findings from that table:

- **Our Gemini launch flag disagrees with the registry.** `acp-known-agents.ts`
  launches it with `--experimental-acp`; the registry lists `--acp` for
  `@google/gemini-cli@0.56.0`. Whether the old flag still works as a deprecated
  alias is unverified — but nothing in the repo would have told us either way,
  and that is exactly the drift a registry diff catches.
- **Cursor becomes tractable.** We excluded it because it installs via
  `curl … | bash` and Socket Firewall cannot wrap that. The registry gives
  per-target archive URLs and the exact `cmd`/`args`, which is a managed path
  where we previously had none.

### What it must not supply

- **The version.** The registry's own README states versions "are automatically
  updated via a cron job that runs hourly … and commits updates directly to
  `main`". Its `version` field is an unreviewed hourly mirror of upstream latest.
  Consuming it as our pin is following `latest` with an extra hop through someone
  else's cron, and it would silently defeat the cooldown in
  [Server-side pin promotion](#server-side-pin-promotion). The registry proposes
  candidates; the lock decides.
- **Integrity for binaries.** Only 48 of 90 binary targets carry a `sha256`, and
  **none of Cursor's six do**. Any binary adapter we adopt needs hashes we record
  and verify ourselves.
- **Any security policy.** The schema has ten fields and none of them is
  `sandbox.allowedDomains`, `homeDirs`, `scratchPaths`,
  `sandboxedPermissionMode`, `requiresClient`, `setup`, `reauth`, or `envHints` —
  which is most of what
  [`acp-known-agents.ts`](../../src/shared/acp-known-agents.ts) actually encodes,
  and all of the part that matters for confinement. A third-party index cannot
  supply our seatbelt profile.
- **A trust decision.** Curation means "supports user authentication", not "safe
  to run": the list includes, for example, a pay-per-call agent marketplace
  settling in USDC. Adding an agent to our catalog stays a human decision.

### How we consume it

**As a committed, diffed input — never a live fetch from the app.** Live-fetching
would let a third party change what Copse spawns, and would add a network
dependency to a security-sensitive catalog. Instead the promotion workflow:

1. Fetches the index and commits `acp-registry-snapshot.json` (the endpoint is a
   mutable pointer — `cache-control: max-age=300`, no signature, and both
   versioned snapshot paths return 404 — so a committed copy is the only way to
   get a reproducible build and a reviewable diff).
2. Diffs the snapshot against `acp-known-agents.ts`: changed launch `args`,
   changed package names, changed distribution kind, agents that vanished.
   Disagreement opens a PR; it does not auto-apply, because the catalog carries
   policy the registry knows nothing about.
3. Uses registry entries as the **candidate feed** for the lock — "this package
   exists under this canonical id with these args" — while the version, cooldown,
   integrity and probe gates stay ours.

Map ids explicitly (`claude-acp` → `claude-agent-acp`). The one apparent coverage
gap — `@zed-industries/claude-code-acp` is not listed — turned out on inspection
to be a signal about our catalog rather than about the registry: that package is
deprecated and renamed. The registry was current and we were not, which is the
argument for the diff in miniature.

### Adopting the registry ids

**Decision: use the registry id as our canonical id, with a permanent alias for
existing data.** One vocabulary shared with every other ACP client is worth the
migration, and the alias is needed regardless because thread history is
append-only.

| ours today         | canonical    | note                             |
| ------------------ | ------------ | -------------------------------- |
| `claude-agent-acp` | `claude-acp` | alias                            |
| `codex`            | `codex-acp`  | alias                            |
| `gemini-cli`       | `gemini`     | alias                            |
| `cursor`           | `cursor`     | already matches                  |
| `claude-code-acp`  | —            | retired, **not** aliased (below) |

The `id` is a persisted key in three places, and each takes a different
treatment:

- **Thread history — never rewritten.** An ACP turn's model is stored on the
  spine line as `acp:<id>` ([`acp.ts`](../../src/shared/acp.ts)). The store is
  append-only history; the alias is applied at _decode_ time in
  `parseAcpModelSelection` / `acpAgentIdFromModel`, so an old thread keeps the
  bytes it was written with and still resolves to the right agent.
- **Remembered permission grants** — keyed `` `${agentId}:${kind}` `` in
  [`acp-permission-grants.ts`](../../src/main/services/acp/acp-permission-grants.ts).
  Mutable current state, not history: rewrite the keys once so a grant is neither
  dropped (silently re-prompting) nor stranded.
- **`registeredAcpAgents`** in settings — same, a one-time forward rewrite, in
  the existing
  [`user-data-migration.ts`](../../src/main/services/storage/user-data-migration.ts)
  path.

Implementation: one exported `LEGACY_ACP_AGENT_IDS` map (old → canonical) in
`@shared`, a `canonicalAcpAgentId()` applied at every boundary where an id
arrives from persisted data, and writes that always emit the canonical id. One
map, one function — an alias table that grows a second copy will drift.

**An alias is not the same as a retirement.** `claude-code-acp` must keep its own
historical id and must **not** resolve to `claude-acp`: it was a genuinely
different adapter (Zed's), and pointing old threads at the current one would
falsify what actually ran. `acpModelDisplayLabel` already falls back to the raw
id for an agent that is no longer configured, so those threads stay readable;
a small historical-titles map would make them render a name rather than a slug.

### Where "stay close to upstream" stops

Two places where matching the registry would be a regression, not an alignment:

- **Its `npx` distribution shape implies `npx package@version` at spawn.** That
  is a network fetch per launch and precisely the floating-fetch pattern
  `docs/supply-chain-security.md` tells us to avoid. Take the package identity
  and args from the registry; install once into the tree; exec the bin directly.
  Same package, different execution model.
- **Its `binary` archives are frequently unverified** — 42 of 90 targets carry no
  `sha256`. Downloading those the way the registry describes means fetching an
  unverified archive over HTTPS and running it. Any binary adapter we adopt gets
  hashes recorded in our lock.

One useful signal for the CI design: the registry verifies every listed agent
"via CI to ensure they return valid `authMethods` in the ACP handshake" — an
independent demonstration that an unauthenticated ACP handshake is runnable in CI,
which is the same property the Tier-1 gate depends on.

## Consolidating the Claude adapters

The catalog carries two Claude entries that are not two adapters. npm's own
metadata settles it:

| package                                 | latest   | published  | status                                                  |
| --------------------------------------- | -------- | ---------- | ------------------------------------------------------- |
| `@zed-industries/claude-code-acp`       | `0.16.2` | 2026-02-17 | **deprecated** — "renamed to @agentclientprotocol/…"    |
| `@agentclientprotocol/claude-agent-acp` | `0.70.0` | 2026-08-18 | current; version history resumes at `0.24.0` 2026-03-26 |

One adapter, renamed and rehomed — the registry entry's `authors` field
(`Anthropic`, `Zed Industries`, `JetBrains`) records the handover. Keeping both
means shipping a six-month-stale protocol surface beside a current one, and
maintaining two near-identical seatbelt profiles that can silently diverge.

Retire `claude-code-acp` as an _offered_ agent, without breaking anyone running
it:

- **Remove** the `KNOWN_ACP_AGENTS` entry and its chip in
  [`providers-section.ts`](../../src/renderer/views/setup/providers-section.ts)
  (`agents: ['claude-agent-acp', 'claude-code-acp']`).
- **Keep** `isClaudeAcpAgent` in [`acp.ts`](../../src/shared/acp.ts) matching the
  `claude-code-acp` command. An existing registered agent must keep working and
  keep its Claude-specific handling; removing a preset is not the same as
  breaking a user's configuration.
- **Offer a one-time migration** for anyone with it configured: same client, same
  login, current adapter.
- **Fix the docs that recommend it.**
  [`acp-setup-guide.md`](../acp-setup-guide.md) currently presents it as
  "Option A … (recommended for you)" with an `npm install -g
@zed-industries/claude-code-acp` line, and
  [`acp-over-ssh.md`](acp-over-ssh.md) uses it as the remote-install example.
  Both now point users at a deprecated package.

This shrinks the lock's npm scope to two adapters and makes registry coverage of
our catalog complete.

## Design

### Lockfile

`acp-adapters.lock.json` at the repo root, generated by
`scripts/update-acp-adapters-lock.mts`, never hand-edited:

```jsonc
{
  "$comment": "Generated. Regenerate with pnpm run lock:acp-adapters.",
  "adapters": {
    "codex-acp": {
      "package": "@agentclientprotocol/codex-acp",
      "version": "<pinned>",
      "packageJson": {/* staged install manifest */},
      "packageLock": {/* npm lockfileVersion 3 */},
      "nativeExecutables": {
        "darwin-arm64": "node_modules/.../<bin>",
        "darwin-x64": "node_modules/.../<bin>",
        "linux-x64": "node_modules/.../<bin>",
      },
    },
  },
}
```

`packageLock` is the load-bearing field: it carries a `sha512` `integrity` per
tarball, so `npm ci` fails closed on any mismatch. `nativeExecutables` is only
needed for adapters that ship platform binaries via `optionalDependencies`
(`codex-acp` bundles `@openai/codex`); adapters that are pure JS omit it.

### Install tree

```
~/.copse/user-data/acp-adapters/<id>/<version>/
```

Under [`copseUserDataDir()`](../../src/main/services/storage/copse-paths.ts),
not `~/.copse/cache/` — the cache root is a build-time convenience for gortex and
the Electron dist, while this is profile state and belongs inside the one
relocatable root alongside `tools/` and `mcp.json`. Versioned directories make an
upgrade atomic: stage the new version beside the old, verify, flip the registered
command, then prune.

Install is `npm ci --ignore-scripts` executed inside the staged directory, still
wrapped by Socket Firewall. `--ignore-scripts` is retained from the current path;
`optionalDependencies` still deliver platform binaries without lifecycle scripts,
which is exactly why the `nativeExecutables` existence check is required before an
install is considered good.

### Launch

`AcpAgentConfig.command` becomes the absolute path to the adapter's entry script
in the tree, spawned as `process.execPath <entry>` with `ELECTRON_RUN_AS_NODE=1`
rather than relying on the bin shebang. Node stops being a user prerequisite for
these adapters. `PATH` resolution via
[`resolveOnPath`](../../src/main/services/acp/acp-detect.ts) stays as the fallback
for user-installed and out-of-catalog agents.

### Reconciler

On app start (deferred, non-blocking) and when ACP settings opens: for each
catalog adapter, compare the on-disk tree against the lock and stage what is
missing. The planning half stays a pure function, matching the existing shape in
[`acp-auto-setup.ts`](../../src/main/services/acp/acp-auto-setup.ts) so
install/register/update decisions remain unit-testable without spawning anything.

`acp-adapter-version.ts`'s `npm view <pkg> version` polling goes away: the lock is
the definition of current, so "outdated" means "tree does not match lock", which
is a local comparison with no registry round-trip and no TTL cache.

## Server-side pin promotion

Every verification Copse does today happens **on the user's machine, after the
fact**: `detectOutdatedNpmAdapter` compares versions once the package is already
installed globally, and the capability/behaviour probes
(`pnpm run probe:acp*`) are manual — `scripts/acp-v2-watch.mts` says so
explicitly ("the agent probes … need real installed agents and stay manual").
The result is that nobody holds a baseline: `docs/acp-support-matrix.{md,json}`
is git-ignored as machine-specific, which is why
[`docs/acp-support-findings.md`](../acp-support-findings.md) exists as prose
pasted from one laptop on one day.

Moving that work into CI inverts it. A pin is proven **before** it reaches
anyone, against a fixed image, with a durable baseline to diff.

### The pipeline

A scheduled workflow (`acp-adapter-lock-sync.yml`), modelled on the existing
[`sync-model-cards.yml`](../../.github/workflows/sync-model-cards.yml) —
schedule + `workflow_dispatch`, `CHECKS_RUNNER` routing, `copse-release-bot` App
token, `create-pull-request`:

1. **Candidate selection, with cooldown.** Read the registry packument's `time`
   map and treat a version as eligible only once
   `now - time[version] >= cooldownDays`. Use **7 days**, matching the
   `cooldown.default-days: 7` already set in
   [`.github/dependabot.yml`](../../.github/dependabot.yml), rather than
   introducing a second number for the same idea. Never follow a prerelease
   dist-tag; skip versions marked deprecated.
2. **Stage and install.** Regenerate the lock entry, then `npm ci
--ignore-scripts` into a scratch tree with `ignore-scripts=true` written into
   the staged `.npmrc`, so a nested config cannot re-enable lifecycle scripts.
3. **Static gates** — no agent, no secrets, no model spend:
   - **Integrity.** `npm ci` fails closed on any tarball whose hash does not
     match the lock. This is the gate, not a formality.
   - **Lifecycle-script tripwire.** If the new version, or any newly-added
     transitive dependency, declares `preinstall` / `install` / `postinstall` /
     `prepare`, fail the run and demand review. This is what turns
     `--ignore-scripts` from a passive mitigation into an active signal: we
     already refuse to run those scripts, so a version that starts wanting one
     has changed shape and a human should look.
   - **Dependency-set diff.** New transitive packages, changed publishers, new
     native executables — all block auto-merge.
   - **`npm audit --audit-level=high`** and **`npm audit signatures`** /
     provenance where the publisher supplies it. Both are already named in
     `docs/supply-chain-security.md` phase 3; this is where they earn their keep.
   - **`nativeExecutables`** exist for every declared target and are the expected
     architecture.
4. **Behavioural gate — the Tier-1 capability probe.** This is the client check
   that moves server-side.
   [`acp-capability-probe.ts`](../../src/main/services/acp/acp-capability-probe.ts)
   spawns the adapter, runs `initialize` + `session/new`, and **sends no
   prompt** — so it spends no model tokens and, for well-behaved adapters,
   needs no auth. Render it through
   [`acp-support-matrix.ts`](../../src/main/services/acp/acp-support-matrix.ts)
   and diff against a committed baseline.

   **Matrix unchanged → eligible for auto-merge. Matrix moved → blocked, labelled
   for review.** That is a far stronger merge criterion than "the version
   number went up": it asserts the new adapter still negotiates the capabilities
   the app's code paths assume.

   This requires a baseline that is reproducible rather than machine-specific —
   a CI-produced `acp-support-baseline.json` generated on a pinned image, not the
   currently-gitignored local artifact.

5. **Merge.** `enablePullRequestAutoMerge` via the same GraphQL path
   [`promote-develop.yml`](../../.github/workflows/promote-develop.yml) already
   uses, so the bump lands only when the required `CI Passed` gate is green and
   never bypasses it.

### What CI cannot prove

State the limits rather than implying coverage we do not have:

- **Adapters with `requiresClient` need that client present.** Whether Tier-1
  completes unauthenticated with `claude` installed but not signed in is an
  empirical, per-adapter fact — measure it before designing around it. Enable
  auto-merge **per adapter**, only where Tier-1 is reliably green without
  secrets; the rest get the static gates plus mandatory human review. `codex-acp`
  is the likely first candidate: standalone, self-authenticating, no client gate.
- **Tier-2 behaviour and Tier-3 long-run probes cost real turns and real
  credentials.** They stay off the auto-merge path. Run them on a slower
  schedule on the self-hosted fleet if we want the coverage.
- **None of this constrains the adapter at runtime.** `--ignore-scripts` blocks
  install-time execution only; the adapter's code runs when the agent is
  spawned. The seatbelt is still the boundary that matters.

### The cooldown cuts both ways

A cooldown shortens exposure to a compromised publish that gets yanked within
days — the actual attack it defends against. It equally delays a security fix.
So the window needs a documented override: a `workflow_dispatch` input that
promotes a named version immediately, used when an advisory says to. A cooldown
with no escape hatch is how a CVE fix sits unmerged for a week.

## Security

- **Integrity.** Tarball hashes from the lock, enforced by `npm ci`. This is the
  guarantee the current path lacks entirely.
- **Blast radius.** Nothing is written outside the Copse profile root. A bad
  adapter no longer persists in the user's global prefix after Copse is removed.
- **Socket Firewall** continues to wrap the install; the change is `ci` in a
  staged directory instead of `install -g`.
- **No install-time script execution, enforced twice.** `--ignore-scripts` on the
  command line and `ignore-scripts=true` in the staged `.npmrc`, on the CI side
  and the client side alike. A version that newly wants a lifecycle script fails
  the promotion run rather than silently having it skipped.
- **Approval.** Keep the explicit approval gate on first network fetch — it is a
  package download that executes later — but the copy can honestly change from
  "install `<pkg>` globally" to "download the pinned `<pkg>` `<version>` into
  Copse's own directory". Record it in the decision log as `kind: install`
  (`docs/decision-log-format.md`), which already covers this event type.
- **Seatbelt.** The adapters spawn under ASRT with per-agent `homeDirs` /
  `scratchPaths` from the catalog. The new tree is a **read** path the profile
  must allow, and switching the interpreter to Electron's Node shifts the relevant
  allowance from
  [`resolveNodeToolchainAllowRead`](../../src/main/project-sandbox/config.ts) to
  `electronRuntimeAllowReadPaths`. Getting this wrong fails at spawn, loudly —
  but it must be covered by a test, because the sandbox is the real boundary on
  macOS.

## Phasing

0. **Catalog hygiene** — independent of everything below and landable first.
   Retire `claude-code-acp` as an offered agent, adopt the registry ids with the
   `LEGACY_ACP_AGENT_IDS` alias and the grants/settings migration, and fix the
   docs that recommend a deprecated package. Nothing here depends on the lock.
1. **Lock + installer + verification.** Generator script, `acp-adapters.lock.json`,
   staged `npm ci` into the versioned tree, `nativeExecutables` existence check,
   reconciler, decision-log entry. Registered command still points at the tree's
   bin. Behind a setting so it can be rolled back.
2. **Promotion pipeline.** `acp-adapter-lock-sync.yml`: cooldown-gated candidate
   selection, static gates, CI-produced support-matrix baseline, PR via the
   release bot. **Human merge only** in this phase — run it long enough to learn
   whether the matrix diff is stable before trusting it to merge on its own.
3. **Auto-merge, per adapter.** Turn on `enablePullRequestAutoMerge` for the
   adapters whose Tier-1 probe has proven green and non-flapping in phase 2.
   Others stay human-reviewed indefinitely; that is an acceptable end state, not
   a gap to close.
4. **Electron Node for the interpreter.** Spawn via `process.execPath`, update the
   seatbelt allow-read, drop the user's Node as a prerequisite for catalog
   adapters.
5. **Retire the global path.** Remove `installGlobalNpmPackage`'s ACP caller and
   the `npm view` version probe. Migration: users with an existing global install
   keep it working (PATH fallback stays); prefer the tree when present, and never
   uninstall anything from their prefix on their behalf.
6. **Optional: build-time staging.** Only for adapters where redistribution is
   cleared, and only if first-run offline install turns out to matter. Everything
   above stays as the fallback, because it must — see the SSH trap below.

## Known implementation traps

- **The lock needs an owner and a cadence.** A pin that nobody refreshes is a
  frozen vulnerability. The promotion pipeline is that owner, which is why it is
  phase 2 rather than a follow-up.
- **The matrix diff will flap unless volatile fields are excluded.**
  [`docs/acp-support-findings.md`](../acp-support-findings.md) already records the
  failure mode: across identical runs "the only value that jittered … was the
  slash-command count", a documented race. A naive whole-JSON diff is red every
  night and therefore ignored within a week. The baseline comparison must be
  field-aware, and the excluded fields listed with their reason — the same
  acknowledge-with-reasoning discipline `scripts/acp-v2-watch.mts` uses.
- **Auto-merge must never land a lock whose adapter never spawned.** A probe that
  errors, times out, or is skipped because the client binary is absent is not a
  pass. Fail closed: absent evidence blocks the merge.
- **`'codex'` is overloaded — do not find-and-replace it.** It is the ACP agent
  id _and_ an unrelated plan-usage provider name persisted in usage history
  ([`plan-usage-bridge.ts`](../../src/main/services/plan-usage-bridge.ts),
  [`plan-window-history.ts`](../../src/shared/usage/plan-window-history.ts) both
  write `provider: 'codex'`). Only the agent-id namespace moves to `codex-acp`;
  a repo-wide rename corrupts stored usage records. `acp-agent-service.ts`'s
  `agent.id !== 'codex'` check is the agent namespace and does move.
- **Never let the registry version become the pin.** It is an hourly unreviewed
  mirror of upstream latest. Any code path that reads `registry.version` and
  writes it into the lock without passing the cooldown and probe gates has
  reintroduced the exact problem this plan exists to fix.
- **A green CI probe is not a green user machine.** CI runs one OS on a fixed
  image with no credentials. Keep the client-side `nativeExecutables` check and
  the post-install spawn verification; the server-side gate reduces risk, it does
  not remove the need to verify locally.
- **SSH is unaffected and must stay that way.**
  [`acp-ssh-transport.ts`](../../src/main/services/acp/acp-ssh-transport.ts)
  spawns the agent on the **remote** host, where a local tree is meaningless. The
  remote path keeps resolving on the remote `PATH`; any code that assumes the
  tree exists must be behind the local-execution branch.
- **`--ignore-scripts` + `optionalDependencies`.** A partially-populated tree looks
  successful to npm and fails at spawn. Verify the native executable exists
  _before_ flipping the registered command.
- **Adapter version ≠ client version.** See non-goals. Do not let the Settings UI
  imply the agent itself is pinned.
- **Version-directory pruning.** Prune only after a successful spawn on the new
  version, or a bad pin leaves no working adapter to fall back to.
- **Don't fabricate a "latest".** With the registry probe gone, the UI must say
  "matches the pinned version" rather than "up to date", which was always a claim
  about the registry rather than about safety.

## Testing

- Unit: lock decoding with a zod decoder (`safeJsonParse` + `decodeWithSchema`,
  per `docs/type-safety.md`); pure planner over lock-vs-tree states; native
  executable verification against fixture trees.
- Installer: `npm ci` against a fixture registry or a pre-staged `node_modules`,
  asserting failure on a corrupted integrity hash. Fail-closed is the behaviour
  under test, not the happy path.
- Sandbox: a focused test that a spawned adapter's interpreter and tree are inside
  the seatbelt allow-read set.
- e2e: ACP settings shows a pinned adapter as ready without touching the global
  prefix.
- Id migration: decoding `acp:codex` from a pre-migration thread resolves to
  `codex-acp`; decoding `acp:claude-code-acp` resolves to itself and still
  renders a label; a grant remembered under a legacy key survives the migration
  exactly once and is not duplicated; every catalog `id` is either a registry id
  or explicitly recorded as having no registry entry.
- Promotion pipeline: unit-test cooldown eligibility against a fixture packument
  `time` map (boundary at exactly N days, missing entries, deprecated versions),
  the lifecycle-script tripwire against fixture manifests, and the field-aware
  matrix comparison against a baseline with only volatile fields changed — it
  must report "no change".

## Decisions

1. **Runtime install from a lock, not a build-time bundle.** Signing cost,
   release-cadence coupling and per-vendor redistribution terms all argue against
   shipping vendor binaries inside the `.app`, and the SSH path needs a runtime
   installer regardless.
2. **App-owned tree under the profile root, not the user's global prefix.**
   Restores the "one relocatable root" property and deletes the nvm-prefix
   bookkeeping.
3. **Electron's Node as the interpreter.** Removes a silent prerequisite; the
   sandbox allowance precedent already exists.
4. **No registry mirror for now.** The lock provides integrity; a mirror provides
   availability, which is not the problem we have.
5. **Clients stay user-managed where the adapter does not bundle one.**
   `claude-agent-acp` pins its `claude` binary transitively through
   `@anthropic-ai/claude-agent-sdk`; `cursor-agent` and `gemini` do not, and
   taking ownership of those is a separate product decision.
6. **Promotion is server-side, and the merge criterion is the capability matrix.**
   A version bump alone proves nothing; an unchanged negotiated capability set
   proves the app's assumptions still hold. Static gates catch supply-chain
   shape changes, the Tier-1 probe catches behavioural ones.
7. **7-day cooldown, matching dependabot, with a documented override.** One
   number for the same idea across the repo, and an escape hatch so advisories
   are not held back by it.
8. **Auto-merge is opt-in per adapter, after a phase of human-merged runs.**
   Earn the trust with observed stability rather than assuming it.
9. **Install-time script execution is denied on both sides, and a new script is a
   review trigger.** The tripwire is worth more than the block.
10. **The ACP registry is the discovery index, not the version source.** It
    supplies identity, canonical ids and distribution shape; the lock supplies
    the version, the cooldown, the integrity check and the probe evidence.
11. **The registry is consumed as a committed snapshot, diffed in CI.** The app
    never fetches it at runtime — that would let a third party change what Copse
    spawns.
12. **One Claude adapter, not two.** `@zed-industries/claude-code-acp` is
    deprecated and renamed; keeping it as an offered preset ships a stale
    protocol surface and a second seatbelt profile to keep in sync. Retire the
    preset, keep existing configurations working.
13. **Adopt the registry ids as canonical, with a permanent alias.** One
    vocabulary shared with other ACP clients. Thread history is never rewritten —
    the alias resolves at decode time — while grants and settings take a one-time
    forward migration. `claude-code-acp` is retired, not aliased: it was a
    different adapter, and redirecting old threads to the current one would
    misreport what ran.
