import { spawnPtyInProjectSandbox } from './project-sandbox/index.ts'
import { loadProjectThreads, saveProjectThread } from './services/thread-store.ts'

/** Hard deadline for the packaged PTY marker to appear. */
const PTY_SMOKE_TIMEOUT_MS = 15_000
/** Delay before the first write so a cold login shell can attach under CI load. */
const PTY_SMOKE_WRITE_DELAY_MS = 500
/**
 * Grace after `onExit` before deciding the stream is done. node-pty can deliver
 * the final `onData` after `onExit` under CI load.
 */
const PTY_SMOKE_EXIT_GRACE_MS = 500

export type PtySmokeExitDecision =
  { action: 'resolve' } | { action: 'reject'; message: string } | { action: 'wait' }

/**
 * Pure settlement rule used after the PTY process exits.
 *
 * - Marker seen → success.
 * - Non-zero exit without marker → fail immediately.
 * - Clean exit without marker → keep waiting for late `onData` (or the outer
 *   timeout). Resolving empty output here is what raced under CI load and
 *   surfaced as "did not receive its command output".
 */
export function decidePtySmokeAfterExit(opts: {
  output: string
  marker: string
  exitCode: number
}): PtySmokeExitDecision {
  if (opts.output.includes(opts.marker)) return { action: 'resolve' }
  if (opts.exitCode !== 0) {
    return {
      action: 'reject',
      message: `Packaged PTY smoke test exited ${String(opts.exitCode)}`,
    }
  }
  return { action: 'wait' }
}

/**
 * Exercise the two runtime facilities that are easy to miss in a packaged app:
 * the native node-pty binding and the filesystem-native thread store. This is
 * deliberately a command-line mode rather than renderer automation so the
 * release job can run it against the signed .app before publication.
 */
export async function runReleaseSmokeTest(): Promise<void> {
  await smokeTestPty()
  await smokeTestThreadPersistence()
}

async function smokeTestPty(): Promise<void> {
  const shell = process.env['SHELL'] || '/bin/bash'
  const marker = 'copse-release-smoke-pty'
  const child = await spawnPtyInProjectSandbox(shell, {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  })
  const output = await new Promise<string>((resolve, reject) => {
    let data = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => {
        reject(new Error('Packaged PTY smoke test timed out'))
      })
    }, PTY_SMOKE_TIMEOUT_MS)
    const resolveIfMarked = (): void => {
      if (!data.includes(marker)) return
      finish(() => {
        child.kill()
        resolve(data)
      })
    }
    child.onData((chunk) => {
      data += chunk
      resolveIfMarked()
    })
    child.onExit(({ exitCode }) => {
      setTimeout(() => {
        const decision = decidePtySmokeAfterExit({
          output: data,
          marker,
          exitCode,
        })
        if (decision.action === 'resolve') {
          finish(() => {
            resolve(data)
          })
          return
        }
        if (decision.action === 'reject') {
          finish(() => {
            reject(new Error(decision.message))
          })
        }
        // `wait`: leave the outer timeout as the deadline for late onData.
      }, PTY_SMOKE_EXIT_GRACE_MS)
    })
    setTimeout(() => {
      child.write(`printf '${marker}\n'; exit\n`)
    }, PTY_SMOKE_WRITE_DELAY_MS)
  })
  if (!output.includes(marker)) {
    throw new Error('Packaged PTY smoke test did not receive its command output')
  }
}

async function smokeTestThreadPersistence(): Promise<void> {
  const projectId = 'release-smoke-project'
  const threadId = 'release-smoke-thread'
  const now = Date.now()
  await saveProjectThread(projectId, {
    id: threadId,
    title: 'Release smoke test',
    status: 'idle',
    messages: [
      {
        id: 'release-smoke-message',
        role: 'user',
        content: 'thread persistence verified',
        toolCalls: [],
        createdAt: now,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: now,
    updatedAt: now,
  })
  const saved = await loadProjectThreads(projectId)
  const thread = saved.find((candidate) => candidate.id === threadId)
  if (thread?.messages[0]?.content !== 'thread persistence verified') {
    throw new Error('Packaged thread persistence smoke test did not round-trip the thread')
  }
}
