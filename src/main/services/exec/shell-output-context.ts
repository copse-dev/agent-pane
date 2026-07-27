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

/**
 * Where a chunk of shell output goes. The shell tool used to reach for
 * `getMainWindow()` directly, which put the whole window module — and through it
 * Electron — on the import path of `createRegistry()`. A benchmark or any other
 * headless caller has no window and needs none: it wants the tool, not the pane
 * the output is painted into. Electron installs the real sink at boot; without
 * one the output is simply not mirrored anywhere (#1313).
 */
export type ShellOutputSink = (chunk: string, taskId: string | null) => void

let shellOutputSink: ShellOutputSink | null = null

export function setShellOutputSink(sink: ShellOutputSink | null): void {
  shellOutputSink = sink
}

/** Mirror a chunk of shell output to the UI, if anything is listening. */
export function emitShellOutput(chunk: string): void {
  shellOutputSink?.(chunk, currentShellTaskId)
}
