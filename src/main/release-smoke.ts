import { spawnPtyInProjectSandbox } from './project-sandbox/index.ts'
import { loadProjectThreads, saveProjectThread } from './services/thread-store.ts'

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
      finish(() => reject(new Error('Packaged PTY smoke test timed out')))
    }, 15_000)
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
      // node-pty can deliver the final onData after onExit under CI load; wait a
      // beat so the marker is not lost when the shell exits cleanly.
      setTimeout(() => {
        if (data.includes(marker)) {
          finish(() => resolve(data))
          return
        }
        if (exitCode !== 0) {
          finish(() => reject(new Error(`Packaged PTY smoke test exited ${String(exitCode)}`)))
          return
        }
        finish(() => resolve(data))
      }, 100)
    })
    // Give the login shell a beat to attach before the first write — avoids a
    // race where the command is dropped on cold PTY startup in CI.
    setTimeout(() => {
      child.write(`printf '${marker}\n'; exit\n`)
    }, 250)
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
