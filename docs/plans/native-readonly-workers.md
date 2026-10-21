# Native named workers: first slice

Brief recorded at `2b25d75dae6e191934890666759fc7919584407c`; rebased onto `41b7c785ff978c66a303874b4c3cfde00fe6e2a5` before completion.

The current custom-agent path runs one explicit slash invocation inline. Native
workflows need bounded independent workers without sharing writable outputs.

## Acceptance criteria recorded before editing

- A native parent can request one or two explicitly named custom agents through
  `run_readonly_workers`; both can execute concurrently under the existing supervisor.
- Every report identifies its worker, agent and terminal state. Each worker has a
  separate named task card and supervisor row, so concurrent streams and cancellation targets cannot mix.
- Workers always inherit a read-only execution scope, even if their definitions
  request write tools. Parent-plan updates are withheld from custom agents. All calls
  still pass the registry's existing permission gate.
- At most two workers are admitted over a parent turn, including repeated/concurrent
  batch calls. Existing custom-agent step/LLM ceilings and depth one remain intact.
- Parent Stop or cancellation of an individual supervised task aborts owned work;
  cancelled/failed workers produce clear results and no successful late report.
- A requested isolated checkout fails before inference while worker worktrees are
  unavailable. No fallback edits the parent checkout.
- Focused tests exercise overlap, ownership/context binding, cancellation, failure,
  limits and read-only enforcement. Electron evidence exercises real tool dispatch
  with deterministic inference and captures attributable cards.

## Contract and scope

This is foreground fan-out/fan-in: the tool waits for all admitted workers. The
supervisor owns admission, deadlines, status and cancellation; no new queue,
continuation dispatcher or recursive agent tree is introduced. Definitions still
come from the existing trusted project/user custom-agent registry. The parent must
already know the exact names from the user's request; no automatic agent catalogue
or description-based selection is added. A call spends at most two worker runs per
parent turn, each with one attempt and a two-minute supervisor deadline. Definitions
may tighten the existing 12-step default / 30-step maximum. This bounds work, not a
guaranteed currency amount. Reports also enter the parent's ordinary tool result.
Workers do not dispatch new primary turns or spend auto-continuation grants.

Supervised handlers are bound to the live parent context, never replayed after
restart. They capture the async context at submission rather than inheriting the
context of whichever supervisor execution frees a slot. Resume cannot reconstruct a
finished parent/provider session; submit a new explicit request after interruption.

## Remaining work

- Isolated **writable** worker checkouts and preparation through existing worktree
  ownership; fail clearly on unsupported targets and cleanup without discarding work.
- Plugin-declared agent discovery, namespacing, enablement/revocation and trust.
- Detached start/status/wait/cancel tools and durable report retrieval/resume.
- Shared monetary/token spend budgets beyond the fixed worker/step/time bounds.
- Real-model evaluations across selected providers; mock runtime evidence proves
  dispatch, containment and rendering, not model quality or all-model compatibility.

Model-role resolution, child skill loading and workflow prose remain with their
respective owning changes. Vendor snapshots and pstack are untouched.
