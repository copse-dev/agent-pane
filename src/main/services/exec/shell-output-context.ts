import { AsyncLocalStorage } from 'node:async_hooks'

// The shell tool streams its child-process output to the renderer over the
// global `agent:shell-output` channel, which historically carried no indication
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

/** A command's process exit, as Node reports it. */
export interface ShellRunExit {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

/**
 * Per-call observer for a run_shell execution. The UI sink above is global and
 * sees a capped view; an ACP client terminal (`terminal/*`, issue #623) needs
 * every byte of ONE command's output plus its real exit status, while that
 * command still goes through run_shell's gate, sandbox and unsandboxed retry.
 * Each spawned attempt reports its own exit, so after a retry the last report
 * describes the run that produced the result.
 */
export interface ShellRunObserver {
  output: (chunk: string) => void
  exit: (status: ShellRunExit) => void
}

const shellRunObserverStorage = new AsyncLocalStorage<ShellRunObserver>()

export function runWithShellRunObserver<T>(observer: ShellRunObserver, fn: () => T): T {
  return shellRunObserverStorage.run(observer, fn)
}

/** The observer bound to the current run_shell call, if any. */
export function currentShellRunObserver(): ShellRunObserver | undefined {
  return shellRunObserverStorage.getStore()
}

/** Mirror a chunk to the UI only. The process runner feeds its observer raw bytes itself. */
export function mirrorShellOutput(chunk: string): void {
  shellOutputSink?.(chunk, currentShellTaskId)
}

/** Mirror a chunk of shell output to the UI and the current call's observer. */
export function emitShellOutput(chunk: string): void {
  mirrorShellOutput(chunk)
  shellRunObserverStorage.getStore()?.output(chunk)
}
