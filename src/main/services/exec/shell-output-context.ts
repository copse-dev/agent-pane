// The shell tool streams its child-process output to the renderer over the
// global `agent:shell_output` channel, which historically carried no indication
// of *which* run_shell call produced it. The terminal pane's "Agent tasks" view
// needs that attribution so each command's output lands in its own card.
//
// run_shell calls execute sequentially within a single agent loop, so a single
// module-level "current task" id is enough: agent-service sets it around each
// run_shell execution and clears it afterwards, and the shell tool stamps the id
// onto every chunk it emits while it is set.
let currentShellTaskId: string | null = null

export function setCurrentShellTaskId(id: string | null): void {
  currentShellTaskId = id
}

export function getCurrentShellTaskId(): string | null {
  return currentShellTaskId
}
