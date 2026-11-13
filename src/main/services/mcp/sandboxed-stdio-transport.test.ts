import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
} from '../../project-sandbox/index.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/spawn.ts'
import { SandboxedStdioClientTransport } from './sandboxed-stdio-transport.ts'

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
