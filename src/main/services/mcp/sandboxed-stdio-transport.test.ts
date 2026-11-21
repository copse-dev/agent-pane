import { afterEach, describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { withTimeout } from '@copse/std/with-timeout.ts'
import {
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
} from '../../project-sandbox/index.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/spawn.ts'
import { SandboxedStdioClientTransport } from './sandboxed-stdio-transport.ts'

function earliestLocalChild(t: TestContext, emit: (child: ChildProcess) => void): () => void {
  const child = new ChildProcess()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  stdin.once('finish', () => {
    queueMicrotask(() => child.emit('close', 0, null))
  })
  t.mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
  t.mock.method(SandboxManager, 'wrapWithSandboxArgv', () =>
    Promise.resolve({ argv: ['/bin/sh', '-c', 'true'], env: {} }),
  )
  t.mock.method(childProcess, 'spawn', () => {
    // Like Node's queued spawn/error, this runs before exec()'s awaited result.
    // Exercise the real transport -> spawn -> local runtime path, not a mock callback.
    queueMicrotask(() => {
      emit(child)
    })
    return child
  })
  syncBuiltinESMExports()
  setProjectSandboxEnabled(true)
  return () => {
    setProjectSandboxEnabled(false)
    t.mock.restoreAll()
    syncBuiltinESMExports()
    stdin.destroy()
    stdout.destroy()
    stderr.destroy()
  }
}

describe('project MCP stdio containment', () => {
  afterEach(async () => {
    await shutdownProjectSandbox()
  })

  it('refuses to start when the OS sandbox is unavailable', async () => {
    setProjectSandboxEnabled(false)
    const transport = new SandboxedStdioClientTransport({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      sandboxRoot: process.cwd(),
      env: {},
    })
    await assert.rejects(transport.start(), /requires an active local project sandbox/)
  })

  it('subscribes the real MCP transport before the earliest spawn and stdio events', async (t) => {
    const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/initialized' }
    const events: string[] = []
    const restore = earliestLocalChild(t, (child) => {
      events.push(`spawn listeners: ${String(child.listenerCount('spawn'))}`)
      child.emit('spawn')
      child.stdout?.emit('data', Buffer.from(serializeMessage(message)))
      child.stderr?.emit('data', Buffer.from('server started'))
    })
    const transport = new SandboxedStdioClientTransport({
      command: process.execPath,
      args: [],
      cwd: process.cwd(),
      sandboxRoot: process.cwd(),
      env: {},
    })
    const received: JSONRPCMessage[] = []
    let stderr = ''
    transport.onmessage = (value): void => {
      received.push(value)
    }
    transport.stderr.on('data', (value: Buffer) => {
      stderr += value.toString()
    })
    try {
      await withTimeout(transport.start(), 1_000, () => {
        throw new Error(`MCP startup missed early events: ${events.join(', ')}`)
      })
      assert.deepEqual(events, ['spawn listeners: 1'])
      assert.deepEqual(received, [message])
      assert.equal(stderr, 'server started')
    } finally {
      await transport.close()
      restore()
    }
  })

  it('rejects startup with the actual earliest child error instead of losing it', async (t) => {
    const failure = new Error('controlled child startup failure')
    const restore = earliestLocalChild(t, (child) => child.emit('error', failure))
    const transport = new SandboxedStdioClientTransport({
      command: process.execPath,
      args: [],
      cwd: process.cwd(),
      sandboxRoot: process.cwd(),
      env: {},
    })
    const errors: Error[] = []
    transport.onerror = (error): void => {
      errors.push(error)
    }
    try {
      await assert.rejects(
        withTimeout(transport.start(), 1_000, () => {
          throw new Error('MCP startup lost the early child error')
        }),
        (error: unknown) => error === failure,
      )
      assert.deepEqual(errors, [failure])
    } finally {
      await transport.close()
      restore()
    }
  })

  it('keeps a mutable project server from writing outside its project', async (t) => {
    if (process.platform === 'win32') {
      t.skip('the project OS sandbox is unavailable on Windows')
      return
    }
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('the host has no enforcing project sandbox')
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'copse-mcp-sandbox-'))
    const testOutputRoot = join(process.cwd(), '.tmp')
    await mkdir(testOutputRoot, { recursive: true })
    const outsideDir = await mkdtemp(join(testOutputRoot, 'copse-mcp-outside-'))
    const outside = join(outsideDir, 'escaped.txt')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Could not bind network probe')
    const script = `
      const fs = require('node:fs')
      const net = require('node:net')
      process.stdin.once('data', async () => {
        let writeBlocked = false
        try { fs.writeFileSync(${JSON.stringify(outside)}, 'escaped') }
        catch { writeBlocked = true }
        const networkBlocked = await new Promise((resolve) => {
          const socket = net.connect(${String(address.port)}, '127.0.0.1')
          socket.once('connect', () => { socket.destroy(); resolve(false) })
          socket.once('error', () => resolve(true))
          socket.setTimeout(1_000, () => { socket.destroy(); resolve(false) })
        })
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { writeBlocked, networkBlocked } }) + '\\n')
      })
    `
    const transport = new SandboxedStdioClientTransport({
      command: process.execPath,
      args: ['-e', script],
      cwd: root,
      sandboxRoot: root,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
    try {
      const message = new Promise<unknown>((resolve, reject) => {
        transport.onmessage = resolve
        transport.onerror = reject
      })
      await transport.start()
      await transport.send({ jsonrpc: '2.0', id: 1, method: 'probe' })
      assert.deepEqual(await message, {
        jsonrpc: '2.0',
        id: 1,
        result: { writeBlocked: true, networkBlocked: true },
      })
      assert.equal(existsSync(outside), false)
    } finally {
      await transport.close()
      await rm(root, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve()
        }),
      )
    }
  })
})
