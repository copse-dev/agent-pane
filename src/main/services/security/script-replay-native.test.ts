import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { AUTO_APPROVAL_LEVEL_SETTING } from '@shared/auto-approval.ts'
import { baseSandboxConfig } from '../../project-sandbox/config.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { runShellTool } from '../../tools/shell-tool.ts'
import { runWithApprovalHandler, type ApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { runShellOnce, type ShellRunResult } from '../exec/foreground-shell-process.ts'
import { envForRendererChildProcess } from '../exec/child-process-env.ts'
import { runWithShellRunObserver, type ShellRunExit } from '../exec/shell-output-context.ts'
import { setSetting } from '../storage/settings.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { runWithActiveRunIdentity, setActiveRunTurnTreeId } from '../thread-models.ts'
import { shellReplayLeaseStore } from './capability-lease.ts'
import { runWithDecisionRecorder, type RecordedDecision } from './decision-log-store.ts'
import { setWorkspaceTrusted } from './workspace-trust.ts'

// This suite must fail on a supported Mac whose sandbox cannot start. The
// owning Mac job also asserts Darwin before selecting it; Linux unit CI skips it.
describe('native macOS script argument leases', { skip: process.platform !== 'darwin' }, () => {
  let parent: string
  let workspace: string
  let script: string
  let outsideRead: string
  let outsideWrite: string
  let interpreter: string
  let secondInterpreter: string
  const previousEnvironment = new Map<string, string | undefined>()
  const registry = new ToolRegistry()
  registry.register(runShellTool)

  const command = (argument: string): string => `./node audit.mjs ${argument}`
  const marker = (): string => readFileSync(outsideWrite, 'utf8')

  function writeScript(path = script, version = 'original'): void {
    writeFileSync(
      path,
      [
        "import { appendFileSync, readFileSync } from 'node:fs'",
        "if (process.argv[2] === 'control') {",
        "  console.log('native-control:' + process.execPath)",
        "} else if (process.argv[2] === 'forged') {",
        // Recognised advisory text is deliberately forgeable. This branch never
        // touches the named target; only actual ASRT evidence may earn a lease.
        `  console.error(${JSON.stringify('[safe-install] cannot listen on loopback here (EPERM): EACCES ' + outsideRead)})`,
        '  process.exitCode = 1',
        '} else {',
        `  const value = readFileSync(${JSON.stringify(outsideRead)}, 'utf8')`,
        `  const line = ${JSON.stringify(version + ':')} + process.argv[2] + ':' + value`,
        `  appendFileSync(${JSON.stringify(outsideWrite)}, line + '\\n')`,
        "  console.log('native-result:' + line)",
        '}',
      ].join('\n'),
    )
  }

  function inOwner<T>(operation: () => T): T {
    return runWithThreadExecutionContext(
      {
        projectId: 'native-script-replay',
        threadId: 'native-script-replay',
        projectRoot: workspace,
        root: workspace,
        checkoutMode: 'shared',
        branch: null,
      },
      () =>
        runWithActiveRunIdentity('native-script-replay', () => {
          setActiveRunTurnTreeId(asTurnTreeId('native-script-replay-tree'))
          return operation()
        }),
    )
  }

  async function execute(
    argument: string,
    approve: ApprovalHandler,
    options: { upfront?: boolean; signal?: AbortSignal } = {},
  ): Promise<{
    output: string
    exits: ShellRunExit[]
    decisions: RecordedDecision[]
    violationCounts: number[]
    violationLines: string[]
    failure: unknown
    result: string | undefined
  }> {
    let output = ''
    let failure: unknown
    let result: string | undefined
    const exits: ShellRunExit[] = []
    const decisions: RecordedDecision[] = []
    const violationCounts: number[] = []
    const violationLines: string[] = []
    try {
      const response = await inOwner(() =>
        runWithDecisionRecorder(
          (decision) => decisions.push(decision),
          () =>
            runWithShellRunObserver(
              {
                output: (chunk) => {
                  output += chunk
                },
                exit: (status) => {
                  exits.push(status)
                  // Observe production evidence without injecting or clearing it.
                  // cleanupAfterCommand removes bwrap mounts, not this store.
                  const violations =
                    SandboxManager.getSandboxViolationStore().getViolationsForCommand(
                      command(argument),
                    )
                  violationCounts.push(violations.length)
                  violationLines.push(...violations.map((violation) => violation.line))
                },
              },
              () =>
                runWithApprovalHandler(approve, () =>
                  registry.executeNormalized(
                    'run_shell',
                    {
                      command: command(argument),
                      timeout_ms: 10_000,
                      ...(options.upfront ? { expects_sandbox_block: true } : {}),
                    },
                    options.signal ?? new AbortController().signal,
                  ),
                ),
            ),
        ),
      )
      result = response.result
    } catch (error) {
      failure = error
    }
    return { output, exits, decisions, violationCounts, violationLines, failure, result }
  }

  function approveLease(requests: ApprovalRequest[]): ApprovalHandler {
    return (request) => {
      requests.push(request)
      assert.equal(
        request.allowTurnTreeLease,
        true,
        'eligible up-front consent should offer a lease',
      )
      assert.equal(request.turnTreeLeaseDefault, false)
      assert.match(request.turnTreeLeaseLabel ?? '', /this script with different arguments/)
      return Promise.resolve({ approved: true, remember: false, grantScope: 'turn-tree' })
    }
  }

  function assertSuccess(run: Awaited<ReturnType<typeof execute>>, argument: string): void {
    assert.equal(run.failure, undefined)
    assert.equal(run.exits.at(-1)?.exitCode, 0, run.output)
    assert.equal(run.exits.at(-1)?.signal, null)
    assert.ok(run.output.includes(`native-result:original:${argument}:synthetic`), run.output)
    assert.ok(marker().includes(`original:${argument}:synthetic\n`))
  }

  before(async () => {
    assert.equal(process.platform, 'darwin')
    mkdirSync(resolve('.tmp'), { recursive: true })
    parent = realpathSync(mkdtempSync(join(resolve('.tmp'), 'native-script-replay-')))
    const inHome = relative(realpathSync(homedir()), parent)
    assert.ok(
      inHome !== '' && inHome !== '..' && !inHome.startsWith(`..${sep}`) && !isAbsolute(inHome),
      'outside targets must be in the denied home tree, not a possibly allowed OS temp directory',
    )
    workspace = join(parent, 'workspace')
    mkdirSync(workspace)
    execFileSync('git', ['init', '--quiet', workspace])
    outsideRead = join(parent, 'outside-read')
    outsideWrite = join(parent, 'outside-write')
    writeFileSync(outsideRead, 'synthetic')
    writeFileSync(outsideWrite, '')
    script = join(workspace, 'audit.mjs')
    interpreter = join(workspace, 'native-first')
    secondInterpreter = join(workspace, 'native-second')
    const original = realpathSync(process.execPath)
    const digest = (file: string): string =>
      createHash('sha256').update(readFileSync(file)).digest('hex')
    for (const target of [interpreter, secondInterpreter]) {
      copyFileSync(original, target)
      chmodSync(target, 0o755)
      assert.equal(digest(target), digest(original), 'execute unchanged Mach-O bytes, not a shim')
    }
    symlinkSync('native-first', join(workspace, 'node'))
    writeScript()
    for (const [key, value] of Object.entries({
      COPSE_DIR: join(parent, 'profile'),
      COPSE_PANEL_USER_DATA: join(parent, 'profile', 'user-data'),
    })) {
      previousEnvironment.set(key, process.env[key])
      process.env[key] = value
    }
    // Derive profile/workspace through COPSE_DIR, including when a developer
    // shell inherited the old workspace override. Do not seed a second layout.
    previousEnvironment.set('COPSE_WORKSPACE_DIR', process.env['COPSE_WORKSPACE_DIR'])
    Reflect.deleteProperty(process.env, 'COPSE_WORKSPACE_DIR')
    await setSetting('autoRunSandboxCommands', true)
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'off')
    await setSetting('safetyClassifierEnabled', false)
    await setSetting('toolPermissionOverrides', {})
    setWorkspaceTrusted(workspace, true)
    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    assert.equal(SandboxManager.isSandboxingEnabled(), true)
    setProjectSandboxEnabled(true)
  })

  beforeEach(() => {
    shellReplayLeaseStore.clear()
    writeFileSync(outsideWrite, '')
    rmSync(script, { force: true })
    writeScript()
    unlinkSync(join(workspace, 'node'))
    symlinkSync('native-first', join(workspace, 'node'))
  })

  after(async () => {
    shellReplayLeaseStore.clear()
    setProjectSandboxEnabled(false)
    await SandboxManager.reset()
    if (workspace) setWorkspaceTrusted(workspace, false)
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    if (parent) rmSync(parent, { recursive: true, force: true })
  })

  it('executes the copied interpreter and enforces actual kernel read/write denials', async (t) => {
    const run = async (raw: string): Promise<ShellRunResult & { exits: ShellRunExit[] }> => {
      const exits: ShellRunExit[] = []
      const result = await inOwner(() =>
        runWithShellRunObserver(
          { output: () => undefined, exit: (status) => exits.push(status) },
          () =>
            runShellOnce(
              raw,
              workspace,
              10_000,
              new AbortController().signal,
              false,
              envForRendererChildProcess(),
            ),
        ),
      )
      return { ...result, exits }
    }
    const control = await run(command('control'))
    assert.equal(control.exitCode, 0, control.output)
    assert.deepEqual(control.exits, [{ exitCode: 0, signal: null }])
    assert.ok(control.output.includes(`native-control:${interpreter}`), control.output)
    assert.equal(control.spawnFailed, undefined)
    writeFileSync(
      join(workspace, 'read.mjs'),
      `import { readFileSync } from 'node:fs'; console.log(readFileSync(${JSON.stringify(outsideRead)}, 'utf8'))`,
    )
    const read = await run('./node read.mjs')
    assert.equal(read.exitCode, 1, read.output)
    assert.deepEqual(read.exits, [{ exitCode: 1, signal: null }])
    assert.equal(read.spawnFailed, undefined, read.output)
    assert.match(read.output, /\b(?:EACCES|EPERM)\b/)
    assert.ok(read.output.includes(outsideRead), read.output)
    assert.equal(marker(), '')
    writeFileSync(
      join(workspace, 'write.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(outsideWrite)}, 'escaped')`,
    )
    const write = await run('./node write.mjs')
    assert.equal(write.exitCode, 1, write.output)
    assert.deepEqual(write.exits, [{ exitCode: 1, signal: null }])
    assert.equal(write.spawnFailed, undefined, write.output)
    assert.match(write.output, /\b(?:EACCES|EPERM)\b/)
    assert.ok(write.output.includes(outsideWrite), write.output)
    assert.equal(marker(), '')
    // Production disables the optional macOS log monitor. Kernel enforcement
    // above does not imply that the runner recorded a reactive replay signal.
    t.diagnostic(
      JSON.stringify({
        enableLogMonitor: false,
        readRecordedViolations: read.sandboxViolationCount,
        writeRecordedViolations: write.sandboxViolationCount,
      }),
    )
  })

  it('approves an explicit up-front command and reuses its real lease for a changed argument', async () => {
    const requests: ApprovalRequest[] = []
    const unapproved = await execute('first', (request) => {
      requests.push(request)
      return Promise.resolve({ approved: false, remember: false })
    })
    assert.deepEqual(unapproved.exits, [{ exitCode: 1, signal: null }])
    assert.notEqual(unapproved.failure, undefined)
    assert.match(unapproved.output, /\b(?:EACCES|EPERM)\b/)
    assert.ok(unapproved.output.includes(outsideRead), unapproved.output)
    assert.equal(requests.length, 0, 'plain Node FS errors do not match a named retry signature')
    assert.equal(marker(), '')
    assert.equal(
      unapproved.decisions.some((decision) =>
        decision.line.source?.startsWith('turn-tree-capability-lease:'),
      ),
      false,
    )
    // Retry the exact raw command through the supported explicit hint. The
    // user, not an absent monitor signal, authorizes this outside execution.
    const first = await execute('first', approveLease(requests), { upfront: true })
    assertSuccess(first, 'first')
    assert.equal(marker(), 'original:first:synthetic\n')
    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.ok(request)
    assert.equal(request.cause, 'shell-expected-sandbox-block')
    assert.equal(request.body, command('first'))
    assert.deepEqual(first.exits, [{ exitCode: 0, signal: null }])
    const issued = first.decisions.find(
      (decision) =>
        decision.line.reasons?.includes('bounded script argument lease issued') === true,
    )
    assert.ok(issued, 'the real permission gate must issue a script argument lease')
    assert.ok(issued.line.source?.startsWith('turn-tree-capability-lease:'))
    const second = await execute('second', approveLease(requests), { upfront: true })
    assertSuccess(second, 'second')
    assert.equal(requests.length, 1)
    const consumed = second.decisions.find(
      (decision) => decision.line.reasons?.includes('bounded exact replay lease used') === true,
    )
    assert.ok(consumed, 'the real permission gate must consume the original lease')
    assert.equal(consumed.line.source, issued.line.source)
    assert.equal(marker(), 'original:first:synthetic\noriginal:second:synthetic\n')
  })

  it('keeps forged denial output interactive and never issues or consumes an argument lease', async () => {
    const requests: ApprovalRequest[] = []
    const forged = await execute('forged', (request) => {
      requests.push(request)
      return Promise.resolve({ approved: false, remember: false })
    })
    assert.equal(forged.failure, undefined)
    assert.deepEqual(forged.exits, [{ exitCode: 1, signal: null }])
    assert.ok(forged.output.includes(`(EPERM): EACCES ${outsideRead}`), forged.output)
    assert.deepEqual(
      forged.violationCounts,
      [0],
      `unexpected recorded evidence makes this a runner-evidence route; it is not signature-only:\n${forged.violationLines.join('\n')}`,
    )
    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.ok(request)
    assert.equal(request.cause, 'shell-sandbox-retry')
    assert.equal(request.allowTurnTreeLease, undefined)
    assert.equal(marker(), '')
    assert.equal(
      forged.decisions.some((decision) =>
        decision.line.source?.startsWith('turn-tree-capability-lease:'),
      ),
      false,
    )
  })

  for (const change of ['write', 'replace', 'script-symlink', 'interpreter-symlink']) {
    it(`requires fresh consent after ${change} and denies any new outside effect`, async () => {
      const requests: ApprovalRequest[] = []
      assertSuccess(await execute('seed', approveLease(requests), { upfront: true }), 'seed')
      assert.equal(marker(), 'original:seed:synthetic\n')
      if (change === 'write') writeScript(script, 'changed')
      else if (change === 'replace') {
        writeScript(join(workspace, 'replacement.mjs'))
        renameSync(join(workspace, 'replacement.mjs'), script)
      } else if (change === 'script-symlink') {
        writeScript(join(workspace, 'other.mjs'))
        unlinkSync(script)
        symlinkSync('other.mjs', script)
      } else {
        unlinkSync(join(workspace, 'node'))
        symlinkSync('native-second', join(workspace, 'node'))
      }
      const before = marker()
      const denied = await execute(
        'changed',
        (request) => {
          requests.push(request)
          return Promise.resolve({ approved: false, remember: false })
        },
        { upfront: true },
      )
      assert.equal(requests.length, 2)
      assert.equal(marker(), before)
      assert.deepEqual(denied.exits, [{ exitCode: 1, signal: null }])
      assert.equal(
        denied.decisions.some((decision) =>
          decision.line.source?.startsWith('turn-tree-capability-lease:'),
        ),
        false,
      )
    })
  }

  it('rejects identity changes during approval and cancellation before any outside effect', async () => {
    let prompts = 0
    const stale = await execute(
      'stale',
      () => {
        prompts++
        writeScript(script, 'changed-during-approval')
        return Promise.resolve({ approved: true, remember: false, grantScope: 'turn-tree' })
      },
      { upfront: true },
    )
    assert.equal(prompts, 1)
    assert.equal(marker(), '')
    assert.deepEqual(stale.exits, [{ exitCode: 1, signal: null }])
    assert.equal(
      stale.decisions.some(
        (decision) =>
          decision.line.reasons?.includes('bounded script argument lease issued') === true,
      ),
      false,
    )
    const controller = new AbortController()
    const cancelled = await execute(
      'cancelled',
      () => {
        prompts++
        controller.abort(new Error('native fixture cancellation'))
        return Promise.resolve({ approved: true, remember: false, grantScope: 'turn-tree' })
      },
      { upfront: true, signal: controller.signal },
    )
    assert.equal(prompts, 2)
    assert.equal(marker(), '')
    assert.equal(cancelled.exits.length, 0)
    assert.equal(
      cancelled.decisions.some(
        (decision) =>
          decision.line.reasons?.includes('bounded script argument lease issued') === true,
      ),
      false,
    )
  })
})
