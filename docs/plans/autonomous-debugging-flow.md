# Autonomous debugging flow

Status: **Proposed.** This plan integrates existing agent-runtime work into one bounded,
privacy-safe autonomy target. It does not create another supervisor, headless contract,
permission engine, or task UI.

## Goal

A deterministic debugging workflow should complete with:

- at most one narrowly scoped approval;
- zero manual “continue” messages;
- zero duplicate side effects after interruption or recovery;
- durable output and artifacts after renderer closure or stream loss; and
- a terminal report that distinguishes proven, disproven, incomplete, blocked, and
  automation-failure outcomes.

The motivating workflow remains private. No original prompt, transcript, path, URL, app
name, screenshot, command output, identifier, or transformed/redacted copy is a test
fixture or repository artifact.

## Existing ownership and deduplication

This plan is an integration map. Work stays with its existing product owner wherever one
exists.

| Capability                                          | Existing owner                                                                                                                                                                                                                                       | Plan action                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy-safe behavioral eval                        | [#744](https://github.com/copse-dev/agent-pane/issues/744) (doctrine evals), [#1272](https://github.com/copse-dev/agent-pane/issues/1272) (real agent path), [#1316](https://github.com/copse-dev/agent-pane/issues/1316) (explicit permission mode) | Add one focused synthetic scenario; do not create another eval umbrella.                                                                           |
| Shell classification / execution-containment parity | [#1248](https://github.com/copse-dev/agent-pane/issues/1248) (platform-aware shell autonomy), [#1436](https://github.com/copse-dev/agent-pane/issues/1436) (sandbox denials rediscovered by trial and error)                                         | Treat the concrete mismatch as #1436 work and policy/UI changes as #1248 work.                                                                     |
| Durable permission evidence                         | [#656](https://github.com/copse-dev/agent-pane/issues/656)                                                                                                                                                                                           | Reuse its canonical permission-decision audit trail; do not create a second audit record.                                                          |
| ACP approval provenance                             | [#1446](https://github.com/copse-dev/agent-pane/issues/1446)                                                                                                                                                                                         | Keep ACP-specific guarded auto-run here; it does not own native turn-tree capability leases.                                                       |
| Durable supervisor and task UI                      | [#1081](https://github.com/copse-dev/agent-pane/issues/1081)                                                                                                                                                                                         | Use the existing supervisor phases, including P2 service, `run_background` consumer decision, and P5 UI.                                           |
| Canonical run/resume lifecycle                      | [#1079](https://github.com/copse-dev/agent-pane/issues/1079)                                                                                                                                                                                         | Extend the shared headless contract and adapters; do not invent a private background-chat protocol.                                                |
| Resumable native runs                               | [#866](https://github.com/copse-dev/agent-pane/issues/866)                                                                                                                                                                                           | Built-in loop recovery belongs here. Use [#1412](https://github.com/copse-dev/agent-pane/issues/1412) as a renderer/thread-switch regression case. |
| ACP resume behavior                                 | Resume shipped under [#830](https://github.com/copse-dev/agent-pane/issues/830); behavioral probes are [#832](https://github.com/copse-dev/agent-pane/issues/832)                                                                                    | Add transient-disconnect coverage only. Open an implementation bug only if that probe fails.                                                       |
| Completion quality gates                            | [#1371](https://github.com/copse-dev/agent-pane/issues/1371), [#1433](https://github.com/copse-dev/agent-pane/issues/1433), and turn-end enforcement [#746](https://github.com/copse-dev/agent-pane/issues/746)                                      | Reuse quality and loop-enforcement work; a product completion-contract API remains a separate focused issue if required.                           |
| Continuation-budget explanation                     | [#1410](https://github.com/copse-dev/agent-pane/issues/1410)                                                                                                                                                                                         | Surface budget exhaustion through the existing issue rather than the supervised-task UI slice.                                                     |
| ACP export fidelity                                 | No exact open issue found; adjacent to [#656](https://github.com/copse-dev/agent-pane/issues/656) and [#1079](https://github.com/copse-dev/agent-pane/issues/1079)                                                                                   | Create one focused bug for lost tool identity and normalized metadata.                                                                             |

Related but not ownership-equivalent: long-horizon execution
[#558](https://github.com/copse-dev/agent-pane/issues/558) and multi-phase workflows
[#865](https://github.com/copse-dev/agent-pane/issues/865) are consumers of the same runtime,
not alternate supervisors or recovery protocols.

## Binding integration constraints

1. [`background-supervisor.md`](background-supervisor.md) remains authoritative for
   durable task identity, lifecycle, wake-up, persistence, cancellation, retry, and task
   UI. Consumers cannot add independent timers or retry loops.
2. [`headless-automation-contract.md`](headless-automation-contract.md) remains
   authoritative for run, resume, cancellation, terminal outcomes, and adapter
   conformance.
3. [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md) decisions 5 and 16 remain
   binding: recovered machine turns consume the turn-tree continuation budget, and stale
   epochs cannot abort or inject into a newer human turn.
4. [`execution-runtime-security.md`](execution-runtime-security.md) remains authoritative
   for execution grants, containment, expiry, audit events, and checkpoint semantics.
5. The main process owns supervised dispatch. Renderer closure or navigation cannot be a
   required continuation mechanism.
6. Ordinary `run_background` remains an in-session process handle. Durable execution is
   explicit and supervisor-backed, never inferred from `timeout_ms`.

## Phase 0 — Privacy-safe autonomy regression

Add a synthetic scenario to the existing eval system. The fixture is authored from
scratch from a behavioral specification, not produced by redacting or paraphrasing the
private source material.

The scenario requests a neutral A/B investigation across:

- baseline and candidate revisions;
- two synthetic environments;
- direct and staged launch modes; and
- a fixed iteration count.

A fake executor provides deterministic outcomes and fault injection:

- one operation class requires a scoped approval;
- a bounded job persists logs and artifacts;
- the response stream disconnects after a committed tool result;
- the renderer closes while supervised work remains active; and
- recovery observes the committed operation ID before deciding whether to continue.

The oracle records:

- approval count;
- human-originated continuation count;
- duplicate operation IDs and side effects;
- completed matrix cases and iteration counts;
- transport interruptions and recoveries;
- artifact availability;
- terminal classification; and
- whether a causal claim is supported by the A/B evidence.

The default eval driver runs the real product agent loop in an ephemeral Docker
container. The container is the host boundary; the agent also initializes the product's
ASRT sandbox and fails before inference unless seatbelt or bwrap is active:

```bash
npm run eval:autonomy
```

`npm run eval:autonomy:host` runs the same fail-closed headless driver directly on a
supported host while iterating.

The same scenario can be driven through Electron when renderer, approval-dialog, or
thread-persistence coverage is needed:

```bash
npm run eval:autonomy:ui
```

Headless mode runs all prompt variants by default;
`COPSE_EVAL_PROMPT_VARIANT=0..2` selects one while iterating. UI mode runs variant 0
unless the same variable selects another. Headless is the behavioral gate; UI mode is
an optional integration probe, not a prerequisite for running the autonomy regression.

Acceptance:

- approvals are at most one;
- manual continuations and duplicate side effects are zero;
- all required cases have a terminal classification;
- unsupported root-cause claims fail the eval;
- task failure is distinct from automation failure; and
- three or more independently authored prompt variants exercise the same objective
  contract without copying source wording.

## Phase 1 — Remove avoidable approvals

### Classification and containment parity

Deliver through [#1436](https://github.com/copse-dev/agent-pane/issues/1436) and
[#1248](https://github.com/copse-dev/agent-pane/issues/1248).

Acceptance:

- classification and actual execution containment agree;
- an approval never describes narrower containment than execution receives;
- macOS sandboxed, sandbox-unavailable, non-macOS, and auto-run-disabled paths are pinned
  by policy tests; and
- classifier output never grants authority.

### Native turn-tree capability leases

Create a focused implementation issue because no current open issue owns this exact
capability. Reuse the execution-grant model and permission audit trail from
[`execution-runtime-security.md`](execution-runtime-security.md) and
[#656](https://github.com/copse-dev/agent-pane/issues/656).

A lease records turn-tree, project, execution root, normalized capability, containment,
expiry, invocation limit, and revocation state. It is not an arbitrary command-prefix
allow-list.

The first native shell capability is a bounded exact replay. It covers commands inside
the project sandbox and may explicitly cover an outside-sandbox replay only when the
command's sole external reason is opaque local execution (for example a workspace script),
never network or outside-path access. The prompt names that containment.
The gate reuses the shared quote-aware shell composition parser to identify the sole
constituent requiring approval. It can compose that byte-identical constituent with a
`cd` to the canonical execution root, `;`/`&&`, and read-only commands or output pipelines
such as `rg`, `head`, and `jq` only when every additional constituent independently passes
ordinary sandbox policy. The original command runs unchanged after the complete
composition is authorized. The same lease may authorize a small fixed number of separate
follow-up commands only when each would independently auto-run under the ordinary
project-sandbox policy. Piped input to the leased command, a different working directory,
environment changes, file redirects, substitutions, grouping, background/`||` control
flow, destructive operations, new external access, and containment escalation never
compose with the lease.

Acceptance:

- one approval can authorize only the declared bounded test matrix;
- scope changes, expiry, destructive operations, or containment escalation prompt again;
- leases cannot cross projects, threads, or human-originated turn trees; and
- every use passes through the existing permission gate and canonical audit path.

## Phase 2 — Durable bounded execution

Deliver the main-process supervisor through [#1081](https://github.com/copse-dev/agent-pane/issues/1081).
A scoped child issue may implement the first supervised shell consumer once P2 is ready.

The explicit workflow input includes command or operation, deadline, expected terminal
condition, retry policy, artifact directory, and permission reference.

Acceptance:

- ordinary dev servers and watchers retain existing session-scoped behavior;
- supervised workflows terminate as `completed`, `failed`, `blocked`, `cancelled`, or
  `timed_out`;
- output and artifacts survive stream loss and renderer closure; and
- cancellation terminates the process tree within a bounded grace period.

## Phase 3 — Safe turn recovery

### Dispatch and checkpoints

Split ownership rather than creating a broad replacement issue:

- scheduling and wake dispatch: [#1081](https://github.com/copse-dev/agent-pane/issues/1081);
- canonical turn/checkpoint representation: [#1079](https://github.com/copse-dev/agent-pane/issues/1079);
- resumable built-in run identity: [#866](https://github.com/copse-dev/agent-pane/issues/866).

Checkpoint committed boundaries only: submission accepted, tool call committed, tool
result persisted, provider response completed, and continuation scheduled. Stable turn
and operation IDs make duplicate dispatch detectable.

Acceptance:

- renderer closure cannot prevent a scheduled continuation;
- completed tool calls are never automatically re-executed;
- unknown external outcomes become `blocked`, not guessed-success or blind retry;
- recovery is bounded by continuation budget, attempts, and wall-clock duration; and
- renderer queue draining cannot independently dispatch the same continuation.

### ACP recovery

Do not reopen ACP resume implementation pre-emptively. Extend
[#832](https://github.com/copse-dev/agent-pane/issues/832) with transient-disconnect,
fingerprint-mismatch, and no-duplicate-side-effect probes. File a focused bug only for a
reproduced conformance failure.

## Phase 4 — Objective completion

First use [#1371](https://github.com/copse-dev/agent-pane/issues/1371),
[#1433](https://github.com/copse-dev/agent-pane/issues/1433), and
[#746](https://github.com/copse-dev/agent-pane/issues/746) to enforce honest terminal
behavior. If workflows require a user-facing completion-contract schema, create a
focused child of [#1079](https://github.com/copse-dev/agent-pane/issues/1079).

Machine-checkable criteria may include required matrix cases, iteration count, artifacts,
allowed terminal classifications, and required A/B comparisons. Unmet criteria produce
`incomplete` or `blocked`, never narrative success.

## Phase 5 — Surface and audit

Supervised-task status and cancellation remain P5 of
[#1081](https://github.com/copse-dev/agent-pane/issues/1081). Continuation-budget messaging
remains [#1410](https://github.com/copse-dev/agent-pane/issues/1410).

Create one new ACP export-fidelity bug. Exports should preserve actual native/MCP tool
name, normalized arguments, operation ID, result reference, and containment decision,
while redacting secrets and bridge tokens.

## Issue and PR policy

Do not create a new umbrella issue for this plan. Link the committed plan from
[#1079](https://github.com/copse-dev/agent-pane/issues/1079) and
[#1081](https://github.com/copse-dev/agent-pane/issues/1081), and create focused child
issues only where identified above. Follow the repository rule of one issue and one
acceptance-criteria set per implementation PR.

The MVP is complete when the synthetic regression reaches one approval, zero manual
continuations, zero duplicate side effects, durable artifacts, and an evidence-backed
terminal outcome. Completion-contract UI and broad activity surfaces are not prerequisites
for that gate.
