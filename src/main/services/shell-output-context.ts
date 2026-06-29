// The shell tool streams its child-process output to the renderer over the
// global `agent:shell_output` channel, which historically carried no indication
// of *which* run_shell call produced it. The terminal pane's "Agent tasks" view
// needs that attribution so each command's output lands in its own card.
//
// A single module-level "current task" id is safe only because of three
// invariants this module relies on — it is NOT a general-purpose guard:
//   1. run_shell calls execute sequentially within a single agent loop (the loop
//      awaits each tool's result before issuing the next call), so at most one
//      run_shell is streaming at a time within a loop.
//   2. Agent runs are serialized across threads (see the active-run pointer in
//      thread-models.ts; the app runs one global model and one run at a time), so
//      two loops never interleave run_shell executions.
//   3. Subagents do not reach this run_shell streaming path, so they can't set or
//      clear this id concurrently with the main loop.
// agent-service sets the id around each run_shell execution and clears it
// afterwards, and the shell tool stamps the id onto every chunk it emits while it
// is set. If any invariant above were broken — i.e. concurrent or parallel
// run_shell executions — this global would misattribute output to the wrong task.
let currentShellTaskId: string | null = null

export function setCurrentShellTaskId(id: string | null): void {
  currentShellTaskId = id
}

export function getCurrentShellTaskId(): string | null {
  return currentShellTaskId
}
