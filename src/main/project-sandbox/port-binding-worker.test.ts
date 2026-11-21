import { tmpdir } from 'node:os'
import { z } from 'zod'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { AUTO_APPROVAL_LEVEL_SETTING } from '@shared/auto-approval.ts'
import { initProjectSandbox, isProjectSandboxEnabled, shutdownProjectSandbox } from './index.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { setApprovalHandler } from '../services/approval.ts'
import { ensureToolPermitted } from '../services/security/permission-gate.ts'
import { shellRunsOutsideSandbox } from '../services/security/command-routing-config.ts'
import { setSetting } from '../services/storage/settings.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process'
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
import { dirname, join } from 'node:path'
import { afterEach, describe, it, mock } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import * as esbuild from 'esbuild'
import { baseSandboxConfig, ensureWorkspaceTmpDir } from './config.ts'
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
import { runWithDecisionRecorder } from '../services/security/decision-log-store.ts'
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
          "process.stdin.resume(); setTimeout(() => process.stdout.write('binding-ready env:' + String(!process.env.COPSE_PORT_BINDING_REQUEST && !process.env.ELECTRON_RUN_AS_NODE && process.env.TEST_SETTING === 'kept') + ' stdin:' + String(!process.stdin.readableEnded) + '\\n'), 100); setInterval(() => {}, 1000)"
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
          await outputContaining(binder, 'binding-ready env:true stdin:true\n'),
          /binding-ready env:true stdin:true/,
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
            tmpDir: worktree,
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

  it('keeps raw GitHub tokens out of a loopback task while brokering is on', async () => {
    if (process.platform === 'win32') return
    const canary = 'ghp_CANARYcanaryCANARYcanary0123456789'
    mkdirSync(join(TEST_OUTPUT_DIR, 'port-binding-fixtures'), { recursive: true })
    fixture = mkdtempSync(join(TEST_OUTPUT_DIR, 'port-binding-fixtures', 'tokens-'))
    previousCopseDir = process.env['COPSE_DIR']
    process.env['COPSE_DIR'] = fixture
    const stub = join(fixture, 'sandbox-runtime-stub.mjs')
    writeFileSync(stub, SANDBOX_RUNTIME_STUB)
    bundleWorker(stub)
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    setProjectSandboxEnabled(true)
    await setSetting('githubCredentialBrokerEnabled', true)
    const previousToken = process.env['GH_TOKEN']
    // Copse's own environment, which the worker inherits.
    process.env['GH_TOKEN'] = canary
    const script =
      "process.stdin.resume(); const keys = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'].filter((key) => process.env[key] !== undefined); process.stdout.write('tokens:[' + keys.join(',') + '] kept:' + String(process.env.TEST_SETTING === 'kept') + '\\n'); setInterval(() => {}, 1000)"
    let task: Awaited<ReturnType<typeof spawnBackgroundProcess>> | undefined
    try {
      task = await runWithDecisionRecorder(
        () => {},
        () =>
          runWithThreadExecutionContext(
            {
              projectId: 'tokens-project',
              threadId: 'tokens-thread',
              projectRoot: fixture,
              root: fixture,
              checkoutMode: 'shared',
              branch: null,
            },
            () =>
              spawnBackgroundProcess(formatArgvForShell(process.execPath, ['-e', script]), {
                cwd: fixture,
                allowPortBinding: true,
                // A caller overlay cannot hand the task a token either.
                env: { TEST_SETTING: 'kept', GITHUB_TOKEN: canary, GH_ENTERPRISE_TOKEN: canary },
              }),
          ),
      )
      const output = await outputContaining(task, '] kept:true\n')
      assert.match(output, /tokens:\[\] kept:true/)
      assert.equal(output.includes(canary), false)
    } finally {
      if (previousToken === undefined) delete process.env['GH_TOKEN']
      else process.env['GH_TOKEN'] = previousToken
      await setSetting('githubCredentialBrokerEnabled', false)
      if (task) {
        const closed = once(task, 'close')
        const cancelEscalation = terminateProcessTree(task)
        await closed
        cancelEscalation()
      }
    }
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
      tmpDir: fixture,
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
    const request = { command: 'x', cwd: '/tmp', tmpDir: '/tmp', overlay }
    assert.equal(parsePortBindingRequest('{'), null)
    assert.equal(parsePortBindingRequest(JSON.stringify({ command: 'x', cwd: '/tmp' })), null)
    assert.equal(
      parsePortBindingRequest(JSON.stringify({ command: 'x', cwd: '/tmp', overlay })),
      null,
    )
    assert.equal(parsePortBindingRequest(JSON.stringify({ ...request, tmpDir: 'relative' })), null)
    assert.equal(parsePortBindingRequest(JSON.stringify({ ...request, cwd: 'relative' })), null)
    assert.equal(parsePortBindingRequest(JSON.stringify({ ...request, env: { A: 1 } })), null)
    assert.equal(
      parsePortBindingRequest(
        JSON.stringify({
          ...request,
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
    assert.deepEqual(parsePortBindingRequest(JSON.stringify(request)), request)
    assert.equal(PORT_BINDING_REQUEST_ENV, 'COPSE_PORT_BINDING_REQUEST')
  })
})

const evidenceSchema = z.object({
  temps: z.record(z.string(), z.string()),
  blocked: z.array(z.object({ path: z.string(), code: z.string() })),
})

it('keeps real approved port hosts on their parent thread scratch', async (t) => {
  if (process.platform === 'win32') {
    t.skip('no project OS sandbox on Windows')
    return
  }
  const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-port-scratch-')))
  const root = join(fixture, 'project')
  const store = join(fixture, 'store')
  const unassigned = join(fixture, 'unassigned')
  mkdirSync(root)
  mkdirSync(unassigned)
  const previousProfile = process.env['COPSE_DIR']
  const previousStore = process.env['COPSE_WORKSPACE_DIR']
  process.env['COPSE_DIR'] = join(fixture, 'profile')
  process.env['COPSE_WORKSPACE_DIR'] = store
  const restoreRoot = setWorkspaceRootForTest(root)
  const worker = portBindingWorkerPath()
  const originalWorker = existsSync(worker) ? readFileSync(worker) : null
  const children: ChildProcess[] = []
  const tempKeys = ['TMPDIR', 'TMP', 'TEMP', 'TMPPREFIX', 'CLAUDE_CODE_TMPDIR']
  const inThread = <T>(threadId: string, action: () => T): T =>
    runWithThreadExecutionContext(
      {
        projectId: 'port-scratch-project',
        threadId,
        projectRoot: root,
        root,
        checkoutMode: 'shared',
        branch: null,
      },
      () => runWithActiveRunIdentity(threadId, action),
    )
  const prompts = { ports: 0, unexpected: 0 }
  setDefaultPluginRegistry(createFirstPartyPluginRegistry())
  setApprovalHandler(async (request) => {
    const approved = request.cause === 'shell-port-binding'
    if (approved) prompts.ports++
    else prompts.unexpected++
    return { approved, remember: false }
  })
  try {
    await setSetting('autoRunSandboxCommands', true)
    await setSetting('safetyClassifierEnabled', false)
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'off')
    await setSetting('toolPermissionOverrides', {})
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT unavailable; real port-host containment requires a capable host')
      return
    }
    mkdirSync(dirname(worker), { recursive: true })
    esbuild.buildSync({
      entryPoints: [join(process.cwd(), 'src/main/project-sandbox/port-binding-worker.ts')],
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      alias: { '@shared': join(process.cwd(), 'src/shared') },
      external: [
        'electron',
        '@anthropic-ai/sandbox-runtime',
        'shell-quote',
        'node-pty',
        'jsdom',
        '@mozilla/readability',
        'turndown',
        'electron-updater',
      ],
    })
    const threads = ['binding-thread-a', 'binding-thread-b']
    const scratch = threads.map((thread) => inThread(thread, ensureWorkspaceTmpDir))
    const host = ensureWorkspaceTmpDir(null)
    const results: { own: string; evidence: z.infer<typeof evidenceSchema> }[] = []
    for (const [index, thread] of threads.entries()) {
      const own = scratch[index] ?? ''
      const other = scratch[1 - index] ?? ''
      const denied = [other, host, unassigned].map((dir) => join(dir, 'forbidden.txt'))
      for (const dir of [other, host, unassigned]) {
        writeFileSync(join(dir, 'host-control.txt'), 'ready')
      }
      const filename = `verify-binder-${String(index)}.mjs`
      writeFileSync(
        join(root, filename),
        [
          "import fs from 'node:fs'",
          `const own = ${JSON.stringify(own)}`,
          "fs.writeFileSync(own + '/assigned.txt', 'assigned')",
          '// Never write the shared ASRT fallback, even when TMPDIR is wrong.',
          "if (process.env.TMPDIR === own) fs.writeFileSync(own + '/env.txt', 'assigned')",
          'const blocked = []',
          `for (const path of ${JSON.stringify(denied)}) {`,
          "  let code = 'none'",
          "  try { fs.writeFileSync(path, 'unexpected') } catch (error) { code = String(error.code) }",
          '  blocked.push({ path, code })',
          '}',
          `const temps = Object.fromEntries(${JSON.stringify(tempKeys)}.map((key) => [key, process.env[key] ?? 'unset']))`,
          "console.log('evidence:' + JSON.stringify({ temps, blocked }))",
        ].join('\n'),
      )
      await inThread(thread, async () => {
        const command = `node ${filename}`
        assert.equal(
          await ensureToolPermitted({
            toolName: 'run_background',
            args: { action: 'start', command, allow_port_binding: true },
          }),
          true,
        )
        assert.equal(
          shellRunsOutsideSandbox(
            command,
            { projectRoot: root, executionRoot: root },
            'run_background',
          ),
          false,
        )
        const child = await spawnBackgroundProcess(command, {
          cwd: root,
          allowPortBinding: true,
          env: Object.fromEntries(tempKeys.map((key) => [key, unassigned])),
          executionTarget: { kind: 'local' },
        })
        children.push(child)
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        const exit = await once(child, 'close', { signal: AbortSignal.timeout(15_000) })
        assert.equal(exit[0], 0, stderr)
        const line = stdout.split('\n').find((value) => value.startsWith('evidence:'))
        assert.ok(line, `${stdout}\n${stderr}`)
        const evidence = safeJsonParse(
          line.slice('evidence:'.length),
          decodeWithSchema(evidenceSchema),
        )
        assert.ok(evidence, stdout)
        t.diagnostic(`Thread ${String(index)}: ${JSON.stringify(evidence)}`)
        assert.equal(readFileSync(join(own, 'assigned.txt'), 'utf8'), 'assigned')
        assert.ok(
          evidence.blocked.every(({ code }) =>
            ['EPERM', 'EACCES', 'EROFS', 'ENOENT'].includes(code),
          ),
          stdout,
        )
        assert.ok(
          denied.every((path) => !existsSync(path)),
          stdout,
        )
        results.push({ own, evidence })
      })
    }
    assert.deepEqual(prompts, { ports: 2, unexpected: 0 })
    assert.deepEqual(activeSandboxNetworkScopeLabels(), [])
    for (const { own, evidence } of results) {
      for (const key of tempKeys) {
        assert.equal(evidence.temps[key], key === 'TMPPREFIX' ? join(own, 'zsh') : own)
      }
      assert.equal(readFileSync(join(own, 'env.txt'), 'utf8'), 'assigned')
    }
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const cancelEscalation = terminateProcessTree(child)
        try {
          await once(child, 'close', { signal: AbortSignal.timeout(3_000) })
        } finally {
          cancelEscalation()
        }
      }),
    )
    await shutdownProjectSandbox()
    setApprovalHandler(null)
    setDefaultPluginRegistry(null)
    restoreRoot()
    if (previousProfile === undefined) delete process.env['COPSE_DIR']
    else process.env['COPSE_DIR'] = previousProfile
    if (previousStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousStore
    if (originalWorker === null) rmSync(worker, { force: true })
    else writeFileSync(worker, originalWorker)
    rmSync(fixture, { recursive: true, force: true })
  }
})
