import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { containedSandboxNetworkConfig, withLoopbackPorts } from './config.ts'

const require = createRequire(import.meta.url)

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end('HTTP/1.0 200 OK\r\n\r\nok'))
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address()
      if (address === null || typeof address === 'string') reject(new Error('no port'))
      else resolve({ server, port: address.port })
    })
  })
}

function run(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  const [file, ...args] = argv
  if (file === undefined) throw new Error('empty argv')
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
}

describe('withLoopbackPorts', () => {
  it('adds only valid ports, and leaves a config with none unchanged', () => {
    const base = { network: containedSandboxNetworkConfig() }
    assert.equal(withLoopbackPorts(base, []), base)
    assert.equal(withLoopbackPorts(base, [0, 70000, 1.5]), base)
    assert.deepEqual(withLoopbackPorts(base, [3000, 3000, 5173]).network, {
      ...containedSandboxNetworkConfig(),
      allowLoopbackPorts: [3000, 5173],
    })
    // Never turns on binding or any domain while adding connect access.
    assert.deepEqual(withLoopbackPorts({}, [3000]).network, {
      ...containedSandboxNetworkConfig(),
      allowLoopbackPorts: [3000],
    })
  })
})

describe('sandbox-runtime loopback-port patch', () => {
  it('reads per-spawn loopback ports in the installed runtime', async () => {
    const entry = require.resolve('@anthropic-ai/sandbox-runtime')
    const manager = await readFile(join(dirname(entry), 'sandbox', 'sandbox-manager.js'), 'utf8')
    assert.match(manager, /allowLoopbackPorts: customConfig\?\.network\?\.allowLoopbackPorts/)
  })

  it(
    'lets a contained command connect to an allowed loopback port and no other',
    { skip: process.platform !== 'darwin' },
    async () => {
      await SandboxManager.initialize(
        {
          network: { allowedDomains: [], deniedDomains: [] },
          filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
        },
        () => Promise.resolve(false),
        false,
      )
      const allowed = await listen()
      const other = await listen()
      try {
        const attempt = async (port: number, ports: readonly number[]): Promise<number | null> => {
          const config = withLoopbackPorts({ network: containedSandboxNetworkConfig() }, ports)
          const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
            `/usr/bin/curl -s -m 3 -o /dev/null http://127.0.0.1:${String(port)}/`,
            '/bin/sh',
            config,
          )
          return run(argv, env)
        }
        assert.equal(await attempt(allowed.port, [allowed.port]), 0)
        assert.notEqual(await attempt(other.port, [allowed.port]), 0)
        assert.notEqual(await attempt(allowed.port, []), 0)
      } finally {
        allowed.server.close()
        other.server.close()
        await SandboxManager.reset()
      }
    },
  )
})
