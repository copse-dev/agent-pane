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
  const shell = process.env['SHELL'] || '/bin/zsh'
  const marker = 'copse-release-smoke-pty'
  const child = await spawnPtyInProjectSandbox(shell, {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
    // The terminal is normally an explicit user-controlled escape from the
    // project sandbox; keep this smoke path aligned with that product path.
    unsandboxed: true,
  })
  const output = await new Promise<string>((resolve, reject) => {
    let data = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Packaged PTY smoke test timed out'))
    }, 15_000)
    child.onData((chunk) => {
      data += chunk
    })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (exitCode !== 0) {
        reject(new Error(`Packaged PTY smoke test exited ${String(exitCode)}`))
        return
      }
      resolve(data)
    })
    child.write(`printf '${marker}'; exit\r`)
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
