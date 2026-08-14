import { spawn, type ChildProcess } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as esbuild from 'esbuild'
import { activeSandboxNetworkScopeLabels } from '../../project-sandbox/network-scope.ts'
import {
  ACP_SESSION_HOST_REQUEST_ENV,
  type AcpSessionHostMessage,
} from './acp-session-host-protocol.ts'
import { parseSessionHostRequest } from './acp-session-host-worker.ts'

const REPO_ROOT = process.cwd()

function makeBundleDir(prefix: string): string {
  const base = join(REPO_ROOT, 'dist-test', 'acp-session-host-fixtures')
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, prefix))
}

function bundleWorker(outDir: string, sandboxRuntimeAlias?: string): string {
  const outfile = join(outDir, 'acp-session-host-worker.js')
  esbuild.buildSync({
    entryPoints: [join(REPO_ROOT, 'src/main/services/acp/acp-session-host-worker.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    alias: {
      '@shared': join(REPO_ROOT, 'src/shared'),
      ...(sandboxRuntimeAlias ? { '@anthropic-ai/sandbox-runtime': sandboxRuntimeAlias } : {}),
    },
    external: [
      'electron',
      ...(sandboxRuntimeAlias ? [] : ['@anthropic-ai/sandbox-runtime']),
      'shell-quote',
      'node-pty',
      'jsdom',
      '@mozilla/readability',
      'turndown',
      'electron-updater',
    ],
  })
  return outfile
}

const SANDBOX_RUNTIME_STUB = `
let config = null
export const SandboxManager = {
  async initialize(next, ask) {
    config = next
    await ask({ host: 'blocked.example', port: 443 })
  },
  getConfig() { return config },
  updateConfig(next) { config = next },
  isSandboxingEnabled() { return config !== null },
  async wrapWithSandboxArgv(command, shell) { return { argv: [shell, '-c', command] } },
  async reset() { config = null },
}
`

function spawnWorker(workerPath: string, cwd: string): ChildProcess {
  return spawn(process.execPath, [workerPath], {
    cwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      [ACP_SESSION_HOST_REQUEST_ENV]: JSON.stringify({
        config: {
          command: process.execPath,
          args: [
            '-e',
            "process.stdout.write(`env:${String(!process.env.COPSE_ACP_SESSION_HOST_REQUEST && !process.env.ELECTRON_RUN_AS_NODE && process.env.AGENT_SETTING === 'kept')}\\n`); process.stdin.on('data', chunk => process.stdout.write('agent:' + chunk.toString()))",
          ],
          env: { AGENT_SETTING: 'kept' },
          cwd,
          sandbox: { allowedDomains: ['api.example'] },
        },
        allowLocalhost: true,
      }),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
}

function waitForReady(child: ChildProcess): Promise<AcpSessionHostMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: AcpSessionHostMessage[] = []
    const timer = setTimeout(() => {
      reject(new Error('session host did not become ready'))
    }, 5_000)
    child.on('message', (message: AcpSessionHostMessage) => {
      messages.push(message)
      if (message.type === 'error') {
        clearTimeout(timer)
        reject(new Error(message.error))
      } else if (message.type === 'ready') {
        clearTimeout(timer)
        resolve(messages)
      }
    })
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`session host exited before ready: ${String(code)}`))
    })
  })
}

function waitForStdout(child: ChildProcess, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    const timer = setTimeout(() => {
      reject(new Error(`session host produced: ${stdout}`))
    }, 5_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes(expected)) {
        clearTimeout(timer)
        resolve(stdout)
      }
    })
  })
}

describe('ACP session host worker', () => {
  it('bundles free of electron and node-pty', () => {
    const dir = makeBundleDir('bundle-')
    const outfile = bundleWorker(dir)
    const code = readFileSync(outfile, 'utf8')
    assert.equal(/require\(["']node-pty["']\)/.test(code), false)
    assert.equal(/require\(["']electron["']\)/.test(code), false)
  })

  it('relays agent stdio without widening the parent process network scope', async () => {
    const dir = makeBundleDir('relay-')
    const stub = join(dir, 'sandbox-runtime-stub.mjs')
    writeFileSync(stub, SANDBOX_RUNTIME_STUB)
    const child = spawnWorker(bundleWorker(dir, stub), dir)
    try {
      const messages = await waitForReady(child)
      assert.deepEqual(activeSandboxNetworkScopeLabels(), [])
      assert.ok(
        messages.some(
          (message) => message.type === 'network-denial' && message.host === 'blocked.example',
        ),
      )
      assert.match(await waitForStdout(child, 'env:true'), /env:true/)
      const output = waitForStdout(child, 'agent:hello')
      child.stdin?.write('hello\n')
      assert.match(await output, /agent:hello/)
    } finally {
      child.kill('SIGTERM')
    }
  })
})

describe('parseSessionHostRequest', () => {
  it('decodes only the spawn and confinement fields', () => {
    assert.deepEqual(
      parseSessionHostRequest(
        JSON.stringify({
          config: {
            command: 'agent',
            args: ['acp'],
            env: { TOKEN: 'configured', IGNORED: 3 },
            cwd: '/workspace',
            sandbox: {
              allowedDomains: ['api.example'],
              homeDirs: ['.agent'],
              scratchPaths: ['/tmp/agent-${uid}'],
            },
            model: 'not-a-spawn-field',
          },
          allowLocalhost: true,
        }),
      ),
      {
        config: {
          command: 'agent',
          args: ['acp'],
          env: { TOKEN: 'configured' },
          cwd: '/workspace',
          sandbox: {
            allowedDomains: ['api.example'],
            homeDirs: ['.agent'],
            scratchPaths: ['/tmp/agent-${uid}'],
          },
        },
        allowLocalhost: true,
      },
    )
  })

  it('fails closed when command, cwd, or sandbox is malformed', () => {
    assert.equal(parseSessionHostRequest('not json'), null)
    assert.equal(
      parseSessionHostRequest(JSON.stringify({ config: { command: 'agent', cwd: '/workspace' } })),
      null,
    )
    assert.equal(
      parseSessionHostRequest(
        JSON.stringify({
          config: { command: 'agent', cwd: '/workspace', sandbox: { allowedDomains: [3] } },
        }),
      ),
      null,
    )
  })
})
