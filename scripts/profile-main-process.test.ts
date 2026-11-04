import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileInspector, summarizeProfile, type CpuProfile } from './profile-main-process.mts'

// An ES module main process: there is no `require` in any scope, and the first
// uncaught exception ends the process, as Copse's fault policy quits the app.
// Written to a file because `node -e` exposes a global `require` and would
// hide the failure.
const TARGET = `
process.on('uncaughtException', (error) => {
  console.error('[process] uncaughtException — ' + error.stack)
  process.exit(3)
})
setInterval(() => {}, 1000)
`

interface Target {
  child: ChildProcess
  url: string
  stderr: () => string
  dispose: () => Promise<void>
}

async function startTarget(): Promise<Target> {
  const dir = await mkdtemp(join(tmpdir(), 'profile-main-process-'))
  const file = join(dir, 'target.mjs')
  await writeFile(file, TARGET)
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', file], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  const url = await new Promise<string>((resolve, reject) => {
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      const match = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(stderr)
      if (match) resolve(match[0])
    })
    child.once('exit', () => {
      reject(new Error(`Target exited before its inspector opened: ${stderr}`))
    })
  })
  return {
    child,
    url,
    stderr: () => stderr,
    dispose: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'exit')
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function inspectorIsListening(url: string): Promise<boolean> {
  try {
    await fetch(`http://${new URL(url).host}/json/list`, { signal: AbortSignal.timeout(500) })
    return true
  } catch {
    return false
  }
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

describe('profileInspector', { timeout: 30_000 }, () => {
  it('profiles an ES module process and closes its inspector without faulting it', async () => {
    const target = await startTarget()
    try {
      const profile = await profileInspector(target.url, 200)
      assert.ok(profile.samples.length > 0)
      assert.ok(
        await waitFor(async () => !(await inspectorIsListening(target.url)), 5000),
        'the target inspector should close',
      )
      // Give any stray deferred callback time to run before judging the target.
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(target.child.exitCode, null, target.stderr())
      assert.doesNotMatch(target.stderr(), /uncaughtException/)
    } finally {
      await target.dispose()
    }
  })

  it('reproduces the require-based close that faulted Copse', async () => {
    const target = await startTarget()
    try {
      const socket = new WebSocket(target.url)
      await once(socket, 'open')
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: "setImmediate(() => require('node:inspector').close())" },
        }),
      )
      await once(socket, 'message')
      socket.close()
      const [code] = await once(target.child, 'exit')
      assert.equal(code, 3)
      assert.match(
        target.stderr(),
        /ReferenceError: require is not defined\n\s+at Immediate\.<anonymous> \(<anonymous>:1:46\)/,
      )
    } finally {
      await target.dispose()
    }
  })
})

describe('summarizeProfile', () => {
  it('orders frames by self time', () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: { functionName: '', url: 'main.js', lineNumber: 0 } },
        { id: 2, callFrame: { functionName: 'hot', url: 'main.js', lineNumber: 9 } },
      ],
      samples: [1, 2, 2],
      timeDeltas: [1000, 2000, 3000],
    }
    assert.deepEqual(summarizeProfile(profile, 2), [
      '5.0ms hot main.js:10',
      '1.0ms (anonymous) main.js:1',
    ])
  })
})
