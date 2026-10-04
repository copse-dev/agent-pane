import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

function listeningPort(child: ChildProcess): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const stdout = child.stdout
    if (!stdout) {
      reject(new Error('MCP fixture did not expose stdout'))
      return
    }
    let output = ''
    let errors = ''
    let complete = false
    const finish = (result: number | Error): void => {
      if (complete) return
      complete = true
      clearTimeout(timer)
      stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      if (result instanceof Error) reject(result)
      else resolvePort(result)
    }
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = /PORT=(\d+)/.exec(output)
      if (match?.[1]) finish(Number(match[1]))
    }
    const onError = (error: Error): void => {
      finish(error)
    }
    const onExit = (): void => {
      finish(new Error(`MCP fixture exited before listening: ${errors}`))
    }
    const timer = setTimeout(() => {
      finish(new Error(`MCP fixture did not listen: ${errors}`))
    }, 10_000)
    stdout.on('data', onData)
    child.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString()
    })
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

it(
  'launches the real HTTP MCP fixture and serves authenticated independent sessions',
  { timeout: 30_000 },
  async (context) => {
    const token = randomUUID()
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', resolve('tests/e2e/fixtures/http-mcp-server.mts')],
      {
        env: { ...process.env, MCP_HTTP_TOKEN: token, MCP_HTTP_PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const clients: Client[] = []
    try {
      const port = await listeningPort(child)
      const url = new URL(`http://127.0.0.1:${String(port)}/mcp`)
      assert.equal((await fetch(url, { signal: context.signal })).status, 401)
      const sessionIds: string[] = []
      for (let index = 0; index < 2; index++) {
        const client = new Client({ name: 'fixture-regression', version: '1.0.0' })
        clients.push(client)
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        })
        await client.connect(transport, { signal: context.signal, timeout: 10_000 })
        assert.ok(transport.sessionId, 'the initialized HTTP session must have an id')
        sessionIds.push(transport.sessionId)
        const tools = await client.listTools(undefined, { signal: context.signal, timeout: 10_000 })
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['add', 'whoami'])
        assert.deepEqual(
          await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } }, undefined, {
            signal: context.signal,
            timeout: 10_000,
          }),
          {
            content: [{ type: 'text', text: '5' }],
          },
        )
      }
      assert.notEqual(
        sessionIds[0],
        sessionIds[1],
        'reloading must allocate an independent MCP session',
      )
    } finally {
      try {
        await Promise.all(
          clients.map(async (client) => {
            await client.close()
          }),
        )
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const stopped = once(child, 'exit')
          child.kill('SIGTERM')
          await stopped
        }
      }
    }
  },
)
