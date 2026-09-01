import { rmSync } from 'node:fs'

interface ExitLifecycle {
  once(event: 'exit', listener: () => void): unknown
}

/**
 * Own one disposable WebdriverIO profile from the worker that created it.
 *
 * `beforeSession` runs in a worker process while `onComplete` runs in the
 * launcher, so launcher-local state cannot clean worker-created directories.
 * Return an eager cleanup for `afterSession`, with process exit as the fallback
 * when session creation fails or the run is interrupted before that hook.
 */
export function installE2eProfileCleanup(
  profilePath: string,
  lifecycle: ExitLifecycle = process,
): () => void {
  let pendingPath: string | null = profilePath
  const cleanup = (): void => {
    if (pendingPath === null) return
    const path = pendingPath
    pendingPath = null
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // The OS may still have an Electron file open during forced teardown.
      // Cleanup is best-effort and must never hide the original test result.
    }
  }
  lifecycle.once('exit', cleanup)
  return cleanup
}
