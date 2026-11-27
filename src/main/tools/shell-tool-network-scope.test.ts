import { after, afterEach, before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import * as esbuild from 'esbuild'
import { AUTO_APPROVAL_LEVEL_SETTING } from '@shared/auto-approval.ts'
import { setProjectSandboxEnabled } from '../project-sandbox/enabled.ts'
import { baseSandboxConfig } from '../project-sandbox/config.ts'
import { activeSandboxNetworkScopeLabels } from '../project-sandbox/network-scope.ts'
import { portBindingWorkerPath } from '../project-sandbox/spawn.ts'
import { acquireWorkerBundleLock } from '../project-sandbox/worker-bundle-lock.test-support.ts'
import { setApprovalHandler, type ApprovalRequest } from '../services/approval.ts'
import { clearGitRemotesCache } from '../services/security/git-remotes.ts'
import { ensureShellCommandPermitted } from '../services/security/permission-gate.ts'
import { setWorkspaceTrusted } from '../services/security/workspace-trust.ts'
import { setSetting } from '../services/storage/settings.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { runShellTool } from './shell-tool.ts'

const REPO_ROOT = process.cwd()
const TEST_OUTPUT_DIR = process.env['COPSE_TEST_OUTPUT_DIR'] ?? join(REPO_ROOT, 'dist-test')

// The isolated host's ASRT: records the network policy it was given, then runs
// the command through the plain shell.
const SANDBOX_RUNTIME_STUB = `
const fs = require('node:fs')
const path = require('node:path')
let config = null
export const SandboxManager = {
  async initialize(next) { config = next },
  getConfig() { return config },
  updateConfig(next) {
    config = next
    if (next.network.allowedDomains.length > 0) {
      fs.writeFileSync(path.join(process.env.SCOPE_RECORD, 'network.json'), JSON.stringify(next.network))
    }
  },
  isSandboxingEnabled() { return config !== null },
  async wrapWithSandboxArgv(command, shell) {
    return { argv: [shell, '-c', command], env: { ...process.env } }
  },
  getSandboxViolationStore() { return { getViolationsForCommand() { return [] } } },
  cleanupAfterCommand() {},
  async reset() { config = null },
}
export function getApplySeccompBinaryPath() { return null }
export function getJavaProxyAgentJarPath() { return null }
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
      '@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js': stub,
      '@anthropic-ai/sandbox-runtime/dist/sandbox/java-proxy-agent.js': stub,
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

// resolveProgramOutsideRoots treats the OS temp dir as writable, so a stand-in
// `git` there never gets a plan: a checkout under /tmp cannot run these.
const OUTPUT_UNDER_TMP = ((): boolean => {
  const tmp = realpathSync.native(tmpdir())
  const out = join(TEST_OUTPUT_DIR)
  return out === tmp || out.startsWith(tmp + '/')
})()

describe('run_shell network scope', () => {
  // port-binding-worker.test.ts bundles the same worker path with other stubs.
  let releaseBundle: (() => void) | null = null
  before(async () => {
    releaseBundle = await acquireWorkerBundleLock()
  })
  after(() => {
    releaseBundle?.()
  })
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function setup(): Promise<{
    root: string
    record: string
    prompts: ApprovalRequest[]
    mainWraps: string[]
  }> {
    if (process.platform === 'win32') throw new Error('unreachable')
    // Outside the OS temp dir, which counts as writable: the stand-in `git`
    // must sit where a network scope accepts a program.
    mkdirSync(join(TEST_OUTPUT_DIR, 'network-scope-fixtures'), { recursive: true })
    const fixture = realpathSync.native(
      mkdtempSync(join(TEST_OUTPUT_DIR, 'network-scope-fixtures', 'run-')),
    )
    cleanups.push(() => {
      rmSync(fixture, { recursive: true, force: true })
      rmSync(portBindingWorkerPath(), { force: true })
    })
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-scoped-shell-')))
    cleanups.push(() => {
      rmSync(root, { recursive: true, force: true })
    })
    mkdirSync(join(root, '.git'))
    writeFileSync(
      join(root, '.git', 'config'),
      '[remote "origin"]\n\turl = https://git.example.com/acme/app.git\n',
    )
    const bin = join(fixture, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        // The last core.hooksPath among the execution-time config entries.
        'i=0; hooks=; while [ "$i" -lt "${GIT_CONFIG_COUNT:-0}" ]; do',
        '  eval k=\\$GIT_CONFIG_KEY_$i; eval v=\\$GIT_CONFIG_VALUE_$i',
        '  [ "$k" = core.hooksPath ] && hooks=$v; i=$((i+1))',
        'done',
        'echo "fake-git $* hooks=$hooks allow=$GIT_ALLOW_PROTOCOL token=${GH_TOKEN:-none}"',
        '',
      ].join('\n'),
    )
    chmodSync(join(bin, 'git'), 0o755)
    const previousPath = process.env['PATH']
    process.env['PATH'] = `${bin}:/usr/bin:/bin`
    const record = join(fixture, 'record')
    mkdirSync(record)
    process.env['SCOPE_RECORD'] = record
    // A token in the test's own environment would reach the command either way.
    const previousToken = process.env['GH_TOKEN']
    delete process.env['GH_TOKEN']
    cleanups.push(() => {
      process.env['PATH'] = previousPath
      delete process.env['SCOPE_RECORD']
      if (previousToken !== undefined) process.env['GH_TOKEN'] = previousToken
    })

    const stub = join(fixture, 'sandbox-runtime-stub.mjs')
    writeFileSync(stub, SANDBOX_RUNTIME_STUB)
    bundleWorker(stub)

    clearGitRemotesCache()
    cleanups.push(clearGitRemotesCache)
    cleanups.push(setWorkspaceRootForTest(root))
    setWorkspaceTrusted(root, true)
    cleanups.push(() => {
      setWorkspaceTrusted(root, false)
    })
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'read')
    await setSetting('autoRunSandboxCommands', true)
    await setSetting('safetyClassifierEnabled', false)
    cleanups.push(async () => {
      await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'off')
    })

    const mainConfig = baseSandboxConfig()
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'getConfig', () => mainConfig)
    mock.method(SandboxManager, 'updateConfig', () => {
      assert.fail('main ASRT allowlist must never change for a scoped command')
    })
    mock.method(SandboxManager, 'cleanupAfterCommand', () => undefined)
    const mainWraps: string[] = []
    mock.method(SandboxManager, 'wrapWithSandboxArgv', (command: string) => {
      mainWraps.push(command)
      return Promise.resolve({
        argv: ['/bin/sh', '-c', 'echo main-contained'],
        env: { ...process.env },
      })
    })
    setProjectSandboxEnabled(true)
    cleanups.push(() => {
      setProjectSandboxEnabled(false)
      mock.restoreAll()
    })

    const prompts: ApprovalRequest[] = []
    setApprovalHandler((request) => {
      prompts.push(request)
      return Promise.resolve({ approved: false, remember: false })
    })
    cleanups.push(() => {
      setApprovalHandler(null)
    })
    return { root, record, prompts, mainWraps }
  }

  async function run(root: string, command: string, expectsBlock = false): Promise<string> {
    const context: ThreadExecutionContext = {
      projectId: 'scoped',
      threadId: 'scoped',
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: null,
    }
    const signal = new AbortController().signal
    return runWithThreadExecutionContext(context, async () => {
      if (!(await ensureShellCommandPermitted(command))) return 'gate declined'
      const result = await runShellTool.execute(
        { command, timeout_ms: 30_000, ...(expectsBlock ? { expects_sandbox_block: true } : {}) },
        signal,
      )
      return typeof result === 'string' ? result : result.result
    })
  }

  it('runs an agent-flagged fetch contained with only its remote host, and asks nothing', async (t) => {
    if (process.platform === 'win32') {
      t.skip('no project OS sandbox on Windows')
      return
    }
    if (OUTPUT_UNDER_TMP) {
      t.skip('the test output directory is under the OS temp dir, which counts as writable')
      return
    }
    const { root, record, prompts, mainWraps } = await setup()
    const output = await run(root, 'git fetch origin main', true)
    assert.deepEqual(prompts, [])
    assert.deepEqual(mainWraps, [])
    assert.match(output, /fake-git fetch origin main hooks=\/dev\/null allow=https:ssh token=none/)
    assert.deepEqual(JSON.parse(readFileSync(join(record, 'network.json'), 'utf8')), {
      allowedDomains: ['git.example.com'],
      deniedDomains: [],
      allowLocalBinding: false,
    })
    assert.deepEqual(activeSandboxNetworkScopeLabels(), [])
  })

  it('still asks to leave the sandbox for a fetch from a URL the user never configured', async (t) => {
    if (process.platform === 'win32') {
      t.skip('no project OS sandbox on Windows')
      return
    }
    if (OUTPUT_UNDER_TMP) {
      t.skip('the test output directory is under the OS temp dir, which counts as writable')
      return
    }
    const { root, record, prompts, mainWraps } = await setup()
    const output = await run(root, 'git fetch https://attacker.example/x main', true)
    assert.deepEqual(
      prompts.map((prompt) => prompt.cause),
      ['shell-expected-sandbox-block'],
    )
    // Declined, so it ran in main's deny-all sandbox; no host was opened for it.
    assert.match(output, /main-contained/)
    assert.equal(mainWraps.length, 1)
    assert.throws(() => readFileSync(join(record, 'network.json'), 'utf8'))
  })
})
