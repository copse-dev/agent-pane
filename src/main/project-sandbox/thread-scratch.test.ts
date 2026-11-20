import { it } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProjectSandbox, isProjectSandboxEnabled, shutdownProjectSandbox } from './index.ts'
import { ensureWorkspaceTmpDir } from './config.ts'
import { runWithActiveRunIdentity } from '../services/active-run-identity.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { setApprovalHandler } from '../services/approval.ts'
import { ensureToolPermitted } from '../services/security/permission-gate.ts'
import { copseToolPermissionId } from '../services/security/tool-permissions.ts'
import { shellRunsOutsideSandbox } from '../services/security/command-routing-config.ts'
import { getSetting, setSetting } from '../services/storage/settings.ts'
import { AUTO_APPROVAL_LEVEL_SETTING, type AutoApprovalLevel } from '@shared/auto-approval.ts'
import { runShellTool } from '../tools/shell-tool.ts'
import { spawnPtyInProjectSandbox } from './spawn.ts'

it('runs and reruns local verification in thread scratch through the real shell gate and sandbox', async (t) => {
  if (process.platform === 'win32') {
    t.skip('no project OS sandbox on Windows')
    return
  }
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'copse-thread-scratch-run-')))
  const root = join(fixture, 'project')
  const store = join(fixture, 'store')
  const forbidden = join(fixture, 'outside', 'evidence.txt')
  mkdirSync(join(root, 'nested', 'links'), { recursive: true })
  mkdirSync(join(root, 'src'))
  mkdirSync(join(fixture, 'outside'))
  const previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
  process.env['COPSE_WORKSPACE_DIR'] = store
  const restoreRoot = setWorkspaceRootForTest(root)
  const previousAutoRun = getSetting('autoRunSandboxCommands', true)
  const previousClassifier = getSetting('safetyClassifierEnabled', true)
  const previousOverrides = getSetting('toolPermissionOverrides', {})
  const previousAutoApproval = getSetting<AutoApprovalLevel>(AUTO_APPROVAL_LEVEL_SETTING, 'off')
  let prompts = 0
  setApprovalHandler(async () => {
    prompts++
    return { approved: false, remember: false }
  })
  const context = {
    projectId: 'scratch-project',
    threadId: 'scratch-thread',
    projectRoot: root,
    root,
    checkoutMode: 'shared' as const,
    branch: null,
  }
  const inThread = <T>(fn: () => T): T =>
    runWithThreadExecutionContext(context, () => runWithActiveRunIdentity(context.threadId, fn))
  try {
    await setSetting('autoRunSandboxCommands', true)
    await setSetting('safetyClassifierEnabled', false)
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'off')
    await setSetting('toolPermissionOverrides', {})
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip(
        'ASRT unavailable on this host; real containment evidence requires a sandbox-capable run',
      )
      return
    }
    await inThread(async () => {
      const scratch = ensureWorkspaceTmpDir()
      const other = runWithActiveRunIdentity('another-thread', () =>
        runWithThreadExecutionContext(
          { ...context, threadId: 'another-thread' },
          ensureWorkspaceTmpDir,
        ),
      )
      assert.notEqual(scratch, other)
      const script = (version: string): string =>
        [
          "import fs from 'node:fs'",
          "import path from 'node:path'",
          `fs.writeFileSync(path.join(process.env.TMPDIR, 'env.txt'), ${JSON.stringify(version)})`,
          `for (const denied of ${JSON.stringify([forbidden, join(other, 'evidence.txt')])}) {`,
          '  let blocked = false',
          "  try { fs.writeFileSync(denied, 'escape') } catch (error) { blocked = ['EPERM', 'EACCES', 'EROFS'].includes(error.code) }",
          "  if (!blocked) throw new Error('outside scratch write was not contained')",
          '}',
          `console.log(${JSON.stringify(version)})`,
          'console.log(process.env.TMPDIR)',
        ].join('\n')
      const run = async (command: string): Promise<void> => {
        assert.equal(
          await ensureToolPermitted({ toolName: 'run_shell', args: { command } }),
          true,
          command,
        )
        assert.equal(
          shellRunsOutsideSandbox(command, { projectRoot: root, executionRoot: root }),
          false,
          command,
        )
        await runShellTool.execute({ command, timeout_ms: 10_000 }, new AbortController().signal)
      }
      const absolute = scratch.startsWith('/private/var/')
        ? scratch.slice('/private'.length)
        : scratch
      for (const version of ['first', 'edited']) {
        writeFileSync(join(root, 'verify.mjs'), script(version))
        await run(`node verify.mjs > '${absolute}/evidence.log'`)
        assert.equal(
          readFileSync(join(scratch, 'evidence.log'), 'utf8'),
          `${version}\n${scratch}\n`,
        )
        assert.equal(readFileSync(join(scratch, 'env.txt'), 'utf8'), version)
      }
      const humanTmp = join(fixture, 'human-temp')
      const tempKeys = ['TMPDIR', 'TMP', 'TEMP', 'TMPPREFIX', 'CLAUDE_CODE_TMPDIR'] as const
      const parentTemps = tempKeys.map((key) => [key, process.env[key]] as const)
      const pty = await spawnPtyInProjectSandbox('/bin/bash', {
        cols: 120,
        rows: 24,
        cwd: root,
        env: Object.fromEntries(tempKeys.map((key) => [key, humanTmp])),
      })
      let ptyOutput = ''
      const lifecycle = { exited: false }
      const dataListener = pty.onData((data) => {
        ptyOutput += data
      })
      try {
        const exitCode = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => {
            pty.kill()
            reject(new Error(`Sandboxed PTY did not exit: ${ptyOutput}`))
          }, 10_000)
          const exitListener = pty.onExit((event) => {
            lifecycle.exited = true
            clearTimeout(timer)
            exitListener.dispose()
            resolve(event.exitCode)
          })
          const print = tempKeys
            .map((key) => `printf '__AGENT_${key}__:%s\\n' "\${${key}-unset}"`)
            .join('; ')
          pty.write(`${print}; printf pty-evidence > "$TMPDIR/pty-evidence.txt"; exit\n`)
        })
        assert.equal(exitCode, 0, ptyOutput)
        for (const key of tempKeys) {
          const expected = key === 'TMPPREFIX' ? join(scratch, 'zsh') : scratch
          assert.ok(ptyOutput.includes(`__AGENT_${key}__:${expected}`), ptyOutput)
        }
        assert.equal(readFileSync(join(scratch, 'pty-evidence.txt'), 'utf8'), 'pty-evidence')
        assert.deepEqual(
          tempKeys.map((key) => [key, process.env[key]]),
          parentTemps,
        )
        t.diagnostic(
          'Sandboxed agent PTY used its assigned thread scratch; parent temp env unchanged',
        )
      } finally {
        dataListener.dispose()
        if (!lifecycle.exited) pty.kill()
      }
      writeFileSync(join(root, 'src', 'fixture.txt'), 'linked evidence')
      await run('ln -sfn ../../src/fixture.txt nested/links/evidence')
      await run('ln -sfn ../../src/fixture.txt nested/links/evidence')
      assert.equal(readlinkSync(join(root, 'nested', 'links', 'evidence')), '../../src/fixture.txt')
      assert.equal(
        readFileSync(join(root, 'nested', 'links', 'evidence'), 'utf8'),
        'linked evidence',
      )
      await run('ln -snf -- src/fixture.txt -literal-evidence')
      assert.equal(readlinkSync(join(root, '-literal-evidence')), 'src/fixture.txt')
      assert.equal(readFileSync(join(root, '-literal-evidence'), 'utf8'), 'linked evidence')
      assert.equal(existsSync(forbidden), false)
      assert.equal(existsSync(join(other, 'evidence.txt')), false)
      assert.equal(prompts, 0, 'contained verification and links must not ask to escape')
      for (const command of ['curl https://example.invalid/fixture', 'pnpm install fixture']) {
        assert.equal(await ensureToolPermitted({ toolName: 'run_shell', args: { command } }), false)
      }
      assert.equal(prompts, 2, 'downloads and installs retain approval')
      const command = `node verify.mjs > '${absolute}/evidence.log'`
      await setSetting('toolPermissionOverrides', { [copseToolPermissionId('run_shell')]: 'ask' })
      assert.equal(await ensureToolPermitted({ toolName: 'run_shell', args: { command } }), false)
      assert.equal(prompts, 3, 'Always ask still applies to contained scratch')
      await setSetting('toolPermissionOverrides', { [copseToolPermissionId('run_shell')]: 'block' })
      assert.equal(await ensureToolPermitted({ toolName: 'run_shell', args: { command } }), false)
      assert.equal(prompts, 3, 'Blocked refuses without asking')
    })
  } finally {
    await shutdownProjectSandbox()
    setApprovalHandler(null)
    await setSetting('autoRunSandboxCommands', previousAutoRun)
    await setSetting('safetyClassifierEnabled', previousClassifier)
    await setSetting('toolPermissionOverrides', previousOverrides)
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, previousAutoApproval)
    restoreRoot()
    if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    rmSync(fixture, { recursive: true, force: true })
  }
})
