import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, it, mock } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import * as esbuild from 'esbuild'
import { baseSandboxConfig } from './config.ts'
import {
  activeSandboxNetworkScopeLabels,
  networkDenialMarker,
  networkDenialsSince,
} from './network-scope.ts'
import {
  parsePortBindingMessage,
  parsePortBindingRequest,
  PORT_BINDING_REQUEST_ENV,
} from './port-binding-protocol.ts'
import { formatArgvForShell } from './sandbox-argv.ts'
import {
  portBindingWorkerPath,
  sandboxViolationCountForBackgroundProcess,
  setProjectSandboxEnabled,
  spawnBackgroundProcess,
} from './spawn.ts'
import { terminateProcessTree } from '../services/exec/subprocess-kill.ts'
import {
  clearThreadReadRoots,
  grantThreadReadRoot,
} from '../services/security/thread-read-roots.ts'
import { runWithActiveRunIdentity } from '../services/active-run-identity.ts'
import {
  registerInternalWorkspaceRoot,
  unregisterInternalWorkspaceRoot,
} from '../services/workspace.ts'

const REPO_ROOT = process.cwd()
const TEST_OUTPUT_DIR = process.env['COPSE_TEST_OUTPUT_DIR'] ?? join(REPO_ROOT, 'dist-test')
const SANDBOX_RUNTIME_HELPER_MODULE =
  '@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js'

const SANDBOX_RUNTIME_STUB = `
const fs = require('node:fs')
let config = null
export const SandboxManager = {
  async initialize(next, ask) {
    config = next
    await ask({ host: 'blocked.example', port: 443 })
  },
  getConfig() { return config },
  updateConfig(next) {
    config = next
    fs.writeFileSync(require('node:path').join(process.env.COPSE_DIR, 'network.json'), JSON.stringify(next.network))
  },
  isSandboxingEnabled() { return config !== null },
  async wrapWithSandboxArgv(command, shell, overlay) {
    fs.writeFileSync(require('node:path').join(process.env.COPSE_DIR, 'overlay.json'), JSON.stringify(overlay))
    return { argv: [shell, '-c', command], env: { ...process.env } }
  },
  getSandboxViolationStore() { return { getViolationsForCommand() { return [1, 2] } } },
  cleanupAfterCommand() {},
  async reset() { config = null },
}
export function getApplySeccompBinaryPath() { return null }
`

function bundleWorker(stub: string): void {
  esbuild.buildSync({
    entryPoints: [join(REPO_ROOT, 'src/main/project-sandbox/port-binding-worker.ts')],
    outfile: portBindingWorkerPath(),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    alias: {
      '@shared': join(REPO_ROOT, 'src/shared'),
      [SANDBOX_RUNTIME_HELPER_MODULE]: stub,
      '@anthropic-ai/sandbox-runtime': stub,
    },
    external: [
      'electron',
      'shell-quote',
      'node-pty',
      'jsdom',
      '@mozilla/readability',
      'turndown',
      'electron-updater',
    ],
  })
}

async function outputContaining(
  proc: Awaited<ReturnType<typeof spawnBackgroundProcess>>,
  expected: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${expected}: ${output}`))
    }, 5_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.includes(expected)) {
        clearTimeout(timer)
        resolve(output)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.once('error', reject)
    proc.once('close', (code) => {
      reject(new Error(`Task exited ${String(code)}: ${output}`))
    })
  })
}

describe('port-binding background host', () => {
  let fixture = ''
  let worktree = ''
  let previousCopseDir: string | undefined

  afterEach(() => {
    setProjectSandboxEnabled(false)
    mock.restoreAll()
    clearThreadReadRoots('network-thread')
    if (worktree) unregisterInternalWorkspaceRoot(worktree)
    if (previousCopseDir === undefined) delete process.env['COPSE_DIR']
    else process.env['COPSE_DIR'] = previousCopseDir
    if (fixture) rmSync(fixture, { recursive: true, force: true })
    rmSync(portBindingWorkerPath(), { force: true })
    fixture = ''
    worktree = ''
  })

  it('keeps main deny-all while an older contained task overlaps an approved binder', async () => {
    if (process.platform === 'win32') return
    mkdirSync(join(TEST_OUTPUT_DIR, 'port-binding-fixtures'), { recursive: true })
    fixture = mkdtempSync(join(TEST_OUTPUT_DIR, 'port-binding-fixtures', 'task-'))
    previousCopseDir = process.env['COPSE_DIR']
    process.env['COPSE_DIR'] = fixture
    const repo = join(fixture, 'repo')
    worktree = join(fixture, 'thread')
    const skill = join(fixture, 'skill')
    mkdirSync(repo)
    mkdirSync(skill)
    const git = (cwd: string, args: string[]): void => {
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Copse Test',
          GIT_AUTHOR_EMAIL: 'copse@example.invalid',
          GIT_COMMITTER_NAME: 'Copse Test',
          GIT_COMMITTER_EMAIL: 'copse@example.invalid',
        },
      })
    }
    git(repo, ['init', '-q'])
    git(repo, ['commit', '--allow-empty', '-m', 'initial'])
    git(repo, ['worktree', 'add', '-q', '-b', 'thread', worktree])
    const registration = await registerInternalWorkspaceRoot(worktree)
    grantThreadReadRoot('network-thread', {
      path: skill,
      canonical: realpathSync.native(skill),
      isDirectory: true,
      label: 'test skill',
    })
    const stub = join(fixture, 'sandbox-runtime-stub.mjs')
    const marker = join(fixture, 'network.json')
    const readTarget = join(fixture, 'approved-read')
    mkdirSync(readTarget)
    writeFileSync(stub, SANDBOX_RUNTIME_STUB)
    bundleWorker(stub)
    const bundle = readFileSync(portBindingWorkerPath(), 'utf8')
    assert.equal(/require\(["']node-pty["']\)/.test(bundle), false)
    assert.equal(/require\(["']electron["']\)/.test(bundle), false)

    const mainConfig = baseSandboxConfig()
    let mainUpdates = 0
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'getConfig', () => mainConfig)
    mock.method(SandboxManager, 'updateConfig', () => {
      mainUpdates += 1
    })
    mock.method(SandboxManager, 'wrapWithSandboxArgv', async () => ({
      argv: [
        process.execPath,
        '-e',
        "process.stdout.write('contained-ready\\n'); setInterval(() => {}, 1000)",
      ],
      env: { ...process.env },
    }))
    mock.method(SandboxManager, 'cleanupAfterCommand', () => {})
    setProjectSandboxEnabled(true)

    await runWithActiveRunIdentity('network-thread', async () => {
      const contained = await spawnBackgroundProcess('contained command', { cwd: worktree })
      let binder: Awaited<ReturnType<typeof spawnBackgroundProcess>> | undefined
      const denialMarker = networkDenialMarker()
      try {
        await outputContaining(contained, 'contained-ready')
        const binderScript =
          "process.stdout.write('binding-ready env:' + String(!process.env.COPSE_PORT_BINDING_REQUEST && !process.env.ELECTRON_RUN_AS_NODE && process.env.TEST_SETTING === 'kept') + '\\n'); setInterval(() => {}, 1000)"
        binder = await spawnBackgroundProcess(
          formatArgvForShell(process.execPath, ['-e', binderScript]),
          {
            cwd: worktree,
            allowPortBinding: true,
            env: { TEST_SETTING: 'kept' },
            readGrantTargets: [readTarget],
            violationId: 'binding-attempt',
          },
        )
        assert.match(
          await outputContaining(binder, 'binding-ready env:true\n'),
          /binding-ready env:true/,
        )
        const workerNetwork: unknown = JSON.parse(readFileSync(marker, 'utf8'))
        assert.deepEqual(workerNetwork, {
          allowedDomains: ['localhost', '127.0.0.1', '::1'],
          deniedDomains: [],
          allowLocalBinding: true,
        })
        const rawOverlay: unknown = JSON.parse(readFileSync(join(fixture, 'overlay.json'), 'utf8'))
        const request = parsePortBindingRequest(
          JSON.stringify({
            command: 'inspect policy',
            cwd: worktree,
            overlay: rawOverlay,
          }),
        )
        assert.ok(request)
        const filesystem = request.overlay.filesystem
        assert.ok(filesystem.allowRead.includes(registration.gitDir))
        assert.ok(filesystem.allowRead.includes(skill))
        assert.ok(filesystem.allowRead.includes(`${skill}/**`))
        assert.ok(filesystem.allowRead.includes(readTarget))
        assert.ok(filesystem.denyWrite.includes(join(registration.commonGitDir, 'config')))
        assert.deepEqual(mainConfig.network.allowedDomains, [])
        assert.equal(mainUpdates, 0)
        assert.deepEqual(activeSandboxNetworkScopeLabels(), [])
        assert.deepEqual(
          networkDenialsSince(denialMarker).map((denial) => denial.host),
          ['blocked.example'],
        )
        assert.equal(contained.exitCode, null)
      } finally {
        if (binder) {
          const closed = once(binder, 'close')
          const cancelEscalation = terminateProcessTree(binder)
          await closed
          cancelEscalation()
          assert.equal(sandboxViolationCountForBackgroundProcess(binder, 'binding-attempt'), 2)
        }
        const closed = once(contained, 'close')
        const cancelEscalation = terminateProcessTree(contained)
        await closed
        cancelEscalation()
      }
    })
  })

  it('does not wrap or spawn a command when ASRT initialization leaves protection disabled', () => {
    mkdirSync(join(TEST_OUTPUT_DIR, 'port-binding-fixtures'), { recursive: true })
    fixture = mkdtempSync(join(TEST_OUTPUT_DIR, 'port-binding-fixtures', 'disabled-'))
    previousCopseDir = process.env['COPSE_DIR']
    const enabledStub = 'isSandboxingEnabled() { return config !== null }'
    assert.ok(SANDBOX_RUNTIME_STUB.includes(enabledStub))
    // initialize resolves and stores its config, but ASRT reports disabled.
    const stub = join(fixture, 'sandbox-runtime-disabled.mjs')
    writeFileSync(
      stub,
      SANDBOX_RUNTIME_STUB.replace(enabledStub, 'isSandboxingEnabled() { return false }'),
    )
    bundleWorker(stub)

    const request = {
      command: formatArgvForShell(process.execPath, [
        '-e',
        "require('node:fs').writeFileSync('spawned', 'yes')",
      ]),
      cwd: fixture,
      overlay: {
        network: {
          allowedDomains: ['localhost', '127.0.0.1', '::1'],
          deniedDomains: [],
          allowLocalBinding: true,
        },
        filesystem: {
          denyRead: [],
          allowRead: [],
          allowWrite: [],
          denyWrite: [],
          allowGitConfig: true,
        },
      },
    }
    const result = spawnSync(process.execPath, [portBindingWorkerPath()], {
      cwd: fixture,
      env: {
        ...process.env,
        COPSE_DIR: fixture,
        [PORT_BINDING_REQUEST_ENV]: JSON.stringify(request),
      },
      encoding: 'utf8',
      timeout: 5_000,
    })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /workspace protection did not start/)
    assert.equal(existsSync(join(fixture, 'overlay.json')), false)
    assert.equal(existsSync(join(fixture, 'spawned')), false)
  })
})

describe('port-binding host protocol', () => {
  it('rejects malformed requests and IPC messages', () => {
    const overlay = {
      network: {
        allowedDomains: ['localhost', '127.0.0.1', '::1'],
        deniedDomains: [],
        allowLocalBinding: true,
      },
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: [],
        denyWrite: [],
        allowGitConfig: true,
      },
    }
    assert.equal(parsePortBindingRequest('{'), null)
    assert.equal(parsePortBindingRequest(JSON.stringify({ command: 'x', cwd: '/tmp' })), null)
    assert.equal(
      parsePortBindingRequest(JSON.stringify({ command: 'x', cwd: 'relative', overlay })),
      null,
    )
    assert.equal(
      parsePortBindingRequest(
        JSON.stringify({ command: 'x', cwd: '/tmp', env: { A: 1 }, overlay }),
      ),
      null,
    )
    assert.equal(
      parsePortBindingRequest(
        JSON.stringify({
          command: 'x',
          cwd: '/tmp',
          overlay: {
            ...overlay,
            network: { ...overlay.network, allowedDomains: ['public.example'] },
          },
        }),
      ),
      null,
    )
    assert.equal(parsePortBindingMessage({ type: 'violations', count: -1 }), null)
    assert.equal(parsePortBindingMessage({ type: 'network-denial', host: 4 }), null)
    assert.deepEqual(
      parsePortBindingRequest(JSON.stringify({ command: 'x', cwd: '/tmp', overlay })),
      {
        command: 'x',
        cwd: '/tmp',
        overlay,
      },
    )
    assert.equal(PORT_BINDING_REQUEST_ENV, 'COPSE_PORT_BINDING_REQUEST')
  })
})
