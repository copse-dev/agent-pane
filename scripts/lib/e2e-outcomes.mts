import { mkdirSync, writeFileSync } from 'node:fs'
import { relative, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Launcher-side hooks survive failed worker/session creation. One worker = one spec. */
export function outcomeHooks(
  directory: string | undefined,
  attempt: number,
): {
  start: (cid: string, specs: string[]) => void
  end: (cid: string, code: number, specs: string[]) => void
} {
  const workers = new Map<string, number>()
  const write = (
    cid: string,
    specs: string[],
    outcome: 'running' | 'passed' | 'failed',
    exitCode: number | null,
  ): void => {
    if (!directory) return
    try {
      mkdirSync(directory, { recursive: true })
      for (const spec of specs) {
        const path = relative(
          process.cwd(),
          spec.startsWith('file:') ? fileURLToPath(spec) : resolve(spec),
        ).replaceAll('\\', '/')
        if (!/^tests\/e2e\/[\w-]+\.e2e\.ts$/.test(path)) throw new Error('Unexpected spec path')
        writeFileSync(
          join(directory, `${String(attempt)}-${cid}-${path.split('/').at(-1) ?? 'spec'}.json`),
          JSON.stringify({
            version: 1,
            spec: path,
            attempt,
            outcome,
            exitCode,
            durationSeconds:
              outcome === 'running' ? null : (Date.now() - (workers.get(cid) ?? Date.now())) / 1000,
            failureClass: outcome === 'failed' ? 'unclassified' : null,
            runId: process.env['GITHUB_RUN_ID'] ?? 'local',
            runAttempt: process.env['GITHUB_RUN_ATTEMPT'] ?? '1',
            shard: process.env['SHARD_INDEX'] ?? '1',
            commit: process.env['GITHUB_SHA'] ?? 'local',
          }) + '\n',
        )
      }
    } catch (error) {
      // Evidence is advisory: never turn a test pass into a failure.
      console.warn('Unable to record e2e outcome', error)
    }
  }
  return {
    start(cid: string, specs: string[]): void {
      workers.set(cid, Date.now())
      write(cid, specs, 'running', null)
    },
    end(cid: string, code: number, specs: string[]): void {
      write(cid, specs, code === 0 ? 'passed' : 'failed', code)
    },
  }
}
