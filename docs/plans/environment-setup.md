# Environment setup: teach Copse what you already approve

Status: **Resolved** — Phases 1–3 are on `main`
([#3950](https://github.com/copse-dev/agent-pane/pull/3950)). The classifier-context idea in Phase 3 is deliberately not built; see
[Later work](#later-work).

## Motivation

Principle #3 in [`docs/threat-model.md`](../threat-model.md#design-principles) says friction must
stay productivity-neutral. Prompts should go to new or risky actions, and per-project allowlists
and remembered decisions should handle the rest. Copse already has those lists: trusted commands,
trusted SSH hosts, web origins and the auto-approval tier. Users rarely fill them in, because doing
so means knowing which list matches which repeated prompt.

Claude Code solves the same problem with `/auto-mode-setup` ("Auto mode works better when it knows
your environment. Takes about a minute."). It reads the project's `CLAUDE.md`, `README.md`, config
files and git remotes, the commands Claude ran in recent sessions and, optionally, shell history
and other repositories' remotes. It drafts prose `autoMode.environment` entries ("Source control:
github.example.com/acme-corp"), and the user accepts or discards the whole draft, which is written
to `~/.claude/settings.json`. Its classifier is an LLM that authorises actions, so prose context
directly changes what runs without a prompt. Claude Code deliberately ignores `autoMode` in project
settings, because a cloned repo could otherwise grant itself trust.

Copse cannot copy that design. [`docs/shell-permissions.md`](../shell-permissions.md) says the
model classifier is never an authorization boundary. Auto-approval is a fixed list of command
shapes in which "no model verdict participates"
([auto-approval classifier](auto-approval-classifier.md#why-this-is-safe)). This plan keeps the
part of the idea that fits: **scan, draft, review, apply.** Every output is a typed value for a
control Copse already enforces with fixed rules.

## Design decisions

These are binding. To diverge, update this section in the same PR.

1. **Suggestions target existing fixed-rule settings only.** The setup produces typed values for
   settings the permission gate already reads. It never produces free text for a model to weigh.
   An applied suggestion does exactly what the same value typed into Settings → Permissions does.
2. **Evidence is the user's own answers, never the repository.** The only input is the project's
   durable decision log: prompts Copse raised and a person answered. No repository file is read,
   not even to label a suggestion (stricter than the first draft of this plan, which allowed
   labels). A cloned repo that names `evil.example` in its README gets nothing. This is the threat
   model's "Workspace vs. host" boundary: project contents are the untrusted side.
3. **Every suggestion is a counterfactual computed by code.** For each answered prompt, main
   re-runs the deterministic rule that raised it with one candidate value added
   (`assessAutoApproval`, `resolveCommandRouting`, `assessShellHarm`) and keeps the candidate only
   if the prompt would not have happened. No model reads anything, and the scan takes well under a
   second.
4. **Each item is reviewed on its own.** Unlike Claude Code's accept-or-discard-all draft, the user
   ticks individual items. Least privilege (principle #1) outweighs saving a click.
5. **Pre-checking follows the evidence.** A candidate appears at 3 approvals from at least 2
   threads within 30 days. A low-risk item (auto-approval level, web origin) starts ticked at 5
   approvals with no refusal. Items that reach past the sandbox (trusted commands, SSH hosts,
   package registries) never start ticked. A refused prompt the change would also have removed
   marks the item declined: shown, but not tickable.
6. **The narrower grant wins.** A command auto-approval recognises as a shape never counts toward
   trusting its binary, sandbox or not. `git push origin` can suggest the push tier, never
   trusting `git` to run every subcommand outside the sandbox.
7. **Main owns the values.** Main computes the suggestions and holds them under an opaque review
   id. The renderer sends back the ticked ids, and main applies the values it computed. An unknown
   id, a stale review or a different active project changes nothing.
8. **Only user-level state, no project file.** Accepted values go to the existing settings.
   Offer state and the setup log live in `user-data/environment-setup.json` and
   `user-data/environment-setup.jsonl` under `~/.copse/` (`COPSE_DIR`). No in-repo file is read as
   configuration.
9. **No agent surface.** No tool starts, completes or influences the setup. Read-only runs,
   automations, unattended containers, ACP agents and paired clients cannot reach it.
10. **Undo is exact.** Undo removes the values one apply added and keeps anything added since. A
    raised level is restored only if nobody has changed it since.

## What the setup reads

| Source                                                        | Used for                                        | Notes                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project decision log (thread `events.jsonl` `decision` lines) | Which prompts repeat and how they were answered | `user` and `mobile-device` verdicts of `approved` / `denied` only. Durable shell decisions omit the command (`SHELL_DECISION_SUBJECT`), so each joins on `toolCallId` to its `run_shell` / `run_background` call in the same spine. Threads untouched in the window are skipped. |
| Current settings                                              | Leaving out what is already granted             | The level, trusted commands, SSH hosts, package registries and effective web allow-list.                                                                                                                                                                                         |
| Configured git remote _names_                                 | Recognising auto-approval shapes                | The same lookup auto-approval uses at run time.                                                                                                                                                                                                                                  |

What it never reads, unlike `/auto-mode-setup`:

- **Shell history.** The Guarded YOLO harm gate lists shell history files as a credential store
  ([shell permissions](../shell-permissions.md#guarded-yolo)).
- **Other repositories under the home directory.** Out of project scope, and a privacy surprise.
- **`~/.ssh/config`, `~/.aws`, `~/.kube/config`, `~/.config/gh`, keychains.** Credential stores.
- **Repository files**, for labels or anything else (decision 2).
- **Remote URLs as trust signals.** Auto-approval keys on remote _names_ because "parsing URLs would
  invite a weaker 'does this look benign' test"
  ([auto-approval classifier](auto-approval-classifier.md#why-this-is-safe)). Claude Code needs a
  "Source control" entry because its classifier sees URLs. Copse's name-based rule already trusts
  every remote the user configured, so no org or host slot is needed.

## Phase 1: suggestions for existing settings (implemented)

| Suggestion                    | Setting                  | Counterfactual                                                                                                                                                                                             | Starts ticked  |
| ----------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Raise the auto-approval level | `shellAutoApprovalLevel` | `assessAutoApproval` at `remote-write` approves a prompted shell command whose tier is above the current level. The lowest level whose covered prompts qualify is offered. Omitted without a live sandbox. | At 5 approvals |
| Trust a host command          | `trustedShellCommands`   | An escalation prompt whose command `trustableCommandHead` accepts (it already excludes shells, interpreters, `env`, `xargs`, …) and `resolveCommandRouting` would route with that basename added.          | Never          |
| Allow a web origin            | `webAllowedOrigins`      | An approved `web-origin` prompt whose origin passes `validateWebOriginPattern` and is not already allowed.                                                                                                 | At 5 approvals |
| Trust an SSH host             | `trustedSshHosts`        | A Guarded YOLO harm prompt that `assessShellHarm` turns into an allow with the command's SSH destinations (`sshDestinationHosts`) trusted.                                                                 | Never          |

Each item shows "You approved this N times in M threads, most recently …", the setting's risk copy,
and recent redacted commands behind a disclosure. Declined items stay in their section, unticked
and disabled, with a sentence saying why.

Approved provider hosts, MCP tool grants and per-tool overrides are out of scope. They already have
their own remember affordances at the prompt.

### Offer

A quiet line at the top of the thread, in the geometry of the Apple-project reminder:

> Copse asked you N times this week about things you always approve. **Review** · Not now · Don’t
> suggest again

Main decides whether to show it: a trusted workspace, auto-run on, at least 5 approved prompts in
the last 7 days that some non-declined suggestion would have removed, not dismissed for good, and
not snoozed. **Not now** and opening the review snooze it for 14 days. The renderer asks when the
project changes and 30 seconds after a thread's status changes.

Settings → Permissions → Shell commands has a **Review suggestions** button, so the flow works
without the offer. After an apply it refreshes only the affected fields, leaving other unsaved
edits alone.

### Review dialog and undo

A modal grouped by setting in Settings → Permissions order, with **Cancel** and **Apply N
changes**. After applying, a toast names the change with **Undo**, which works until the app
restarts. After that the values are ordinary settings edited in Settings.

### Observability

Each applied or undone value is appended to `user-data/environment-setup.jsonl` with source
`environment-setup` and the approval count. Gate decisions that later rely on these settings are
logged as they are today; the setup adds no grant path, so it adds no gate record.

## Phase 2: trusted package registries (implemented)

A user-level list, `trustedPackageRegistries` (Settings → Permissions), holds registry origins.
The Guarded YOLO harm gate's "installs from a package registry other than the default" rule in
`remote-change.ts` lets an install through when every registry the command selects is on the list.

- Trust is by origin (`packageRegistryOrigin`): `https:`, or `http:` to loopback only; no userinfo;
  a bare host needs a dot, so Go's `direct` is never a host.
- Only settings that choose a registry can be trusted: `--registry`, `--index-url`,
  `--extra-index-url`, `--index`, `--default-index`, and `GOPROXY`, `NPM_CONFIG_REGISTRY`,
  `YARN_REGISTRY`, `YARN_NPM_REGISTRY_SERVER`, `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL`,
  `UV_INDEX_URL`, `UV_EXTRA_INDEX_URL`, `UV_INDEX`. Ones that weaken verification
  (`--trusted-host`, `GOSUMDB=off`, `GOINSECURE`, `GOFLAGS=-insecure`) and `GOPROXY=off` still ask.
- Environment setup suggests a registry when trusting it alone turns the harm prompt into an allow
  (`commandPackageRegistries`). Never pre-ticked.
- Standard mode is unchanged: installs are hard-external there.

The list is empty by default, so the gate-replay snapshot and the public test set do not change.

## Phase 3: production targets (implemented)

A user-level list, `productionTargets` (Settings → Permissions), names cluster contexts or
namespaces, cloud projects or profiles, and database or SSH hosts. Under Guarded YOLO any
infrastructure, remote-shell or database program (`kubectl`, `helm`, `terraform`, cloud CLIs,
`ssh`, `psql`, `docker`, …) whose arguments name one asks once, reads included
(`productionTargetReason` in `production-targets.ts`). Matching is on whole words, including an
option's value, a `user@host`'s host and a URL's host, never substrings. It can only add prompts.

Environment setup does not suggest production targets: the only evidence for them is in credential
stores (`~/.kube/config`, cloud profiles) or the repository, and the setup reads neither.

## Later work

- **Environment context for the tier-screening classifier.** The user's lists could be passed as
  context to the `tier-screening.ts` second opinion. That classifier can only add a prompt, so its
  context can only _withhold_ one. Not built: it needs an evaluation on the public command test set
  first, because misleading context weakens the second opinion.
- **Per-project scope.** Trusted commands, web origins, SSH hosts and registries are global
  settings fed by one project's evidence. The review copy says so. Per-project scoping of those
  settings is a separate contract change.
- **Undo across restarts.** Undo is session-only; the setup log records enough to add an undo in
  Settings later.

- **The offer on an empty thread.** The offer lives at the top of the conversation scroll area,
  which has no size while a new thread shows only the centred composer. It appears once the
  thread has messages; the Settings button works everywhere.

## Non-goals

- A prose `environment` / `allow` / `soft_deny` list for any model that decides whether something
  runs.
- Any environment configuration read from the repository.
- Org- or URL-based trust for git remotes.
- Making auto-approval fire without an active sandbox.
- A setup flow the agent can propose or run.

## Validation

- Unit tests: `environment-suggestions.test.ts` (thresholds, refusals, thread spread, shape vs
  binary, non-trustable binaries, web origins, SSH hosts, registries, redaction),
  `environment-evidence.test.ts` (human verdicts only, tool-call join, window),
  `environment-setup.test.ts` (offer, untrusted workspace, main-owned values, stale review, exact
  undo), `environment-setup.test.ts` in the renderer (grouping, ticks, ids sent back, empty state,
  offer), `trusted-package-registries.test.ts`, `production-targets.test.ts`, and new
  `host-reach.test.ts` cases.
- `tests/e2e/environment-setup.e2e.ts` seeds approvals, asserts the offer and review dialog, applies
  and undoes, and saves `environment-setup-offer.png` and `environment-setup-review.png`.
- `benchmarks/escalation-review/testset/gates.mjs --check` and `regression/run.mjs --check` report
  no drift; `shell-gate-replay.test.ts` passes unchanged.
- The full `pnpm run check`, because the change touches permissions and persisted data.
