import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listCursorHooks,
  userHooksConfigPath,
  projectHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
} from './cursor-adapter.ts'
import { runToolGateHooks } from './tool-gate.ts'
import { beginHookRunRecording, endHookRunRecording } from '../hook-run-recorder.ts'
import { getThreadMeta } from '../thread-store.ts'
import { storageSet } from '../storage/storage.ts'
import { parseSpineEntries, type SpineHookRunLine } from '@shared/threads/spine-schema.ts'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'

/** Fire the canonical toolGate event for a Copse tool call (the production gate path). */
function gate(
  toolName: string,
  args: Record<string, unknown>,
  opts: {
    workspaceRoot?: string | null
    executionRoot?: string | null
    projectTrusted?: boolean
  } = {},
): ReturnType<typeof runToolGateHooks> {
  return runToolGateHooks(
    { toolName, args },
    {
      workspaceRoot: opts.workspaceRoot ?? null,
      executionRoot: opts.executionRoot ?? null,
      projectTrusted: opts.projectTrusted ?? false,
    },
  )
}

describe('cursor-adapter', () => {
  let tempHome = ''
  let tempProject = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-cursor-hooks-home-'))
    tempProject = await mkdtemp(join(tmpdir(), 'copse-cursor-hooks-proj-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    await rm(tempHome, { recursive: true, force: true })
    await rm(tempProject, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    const path = userHooksConfigPath()
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(path, JSON.stringify(config), 'utf-8')
  }

  async function writeProjectHooks(config: unknown): Promise<void> {
    await mkdir(join(tempProject, '.cursor'), { recursive: true })
    await writeFile(projectHooksConfigPath(tempProject), JSON.stringify(config), 'utf-8')
  }

  /** Write an executable shell script that prints `responseJson` on stdout. */
  async function writeHookScript(name: string, responseJson: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${responseJson}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  describe('discovery + validation warnings', () => {
    it('lists user hooks and skips unknown events with a warning (decision 8)', async () => {
      await writeUserHooks({
        version: 1,
        hooks: {
          beforeShellExecution: [{ command: './audit.sh' }],
          notARealEvent: [{ command: './nope.sh' }],
        },
      })

      const { hooks, warnings } = await listCursorHooks({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(hooks.length, 1)
      const [hook] = hooks
      assert.ok(hook)
      assert.equal(hook.event, 'beforeShellExecution')
      assert.equal(hook.command, './audit.sh')
      assert.equal(hook.scope, 'user')
      assert.equal(hook.supported, true)
      assert.equal(hook.lastError, undefined)
      assert.equal(warnings.length, 1)
      const [warning] = warnings
      assert.ok(warning)
      assert.match(warning.message, /notARealEvent/)
      assert.equal(warning.source, userHooksConfigPath())
      assert.equal(warning.scope, 'user')
    })

    it('marks every declared Cursor event supported (stop is wired in B3)', async () => {
      await writeUserHooks({
        hooks: {
          beforeShellExecution: [{ command: './gate.sh' }],
          beforeSubmitPrompt: [{ command: './submit.sh' }],
          afterFileEdit: [{ command: './fmt.sh' }],
          stop: [{ command: './notify.sh' }],
          postToolUse: [{ command: './after-success.sh' }],
          postToolUseFailure: [{ command: './after-failure.sh' }],
        },
      })

      const { hooks, warnings } = await listCursorHooks({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(warnings.length, 0)
      // Every Cursor lifecycle event now has a fire site (permission gates + B1
      // beforeSubmitPrompt + B2 afterFileEdit + B3 stop), so none are "unsupported".
      assert.equal(hooks.find((h) => h.event === 'stop')?.supported, true)
      assert.equal(hooks.find((h) => h.event === 'beforeShellExecution')?.supported, true)
      assert.equal(hooks.find((h) => h.event === 'beforeSubmitPrompt')?.supported, true)
      assert.equal(hooks.find((h) => h.event === 'afterFileEdit')?.supported, true)
      assert.equal(hooks.find((h) => h.event === 'postToolUse')?.supported, true)
      assert.equal(hooks.find((h) => h.event === 'postToolUseFailure')?.supported, true)
    })

    it('warns on malformed entries without dropping valid ones', async () => {
      await writeUserHooks({
        hooks: {
          beforeShellExecution: [{ command: './ok.sh' }, { command: '' }, { notCommand: true }],
          beforeMCPExecution: 'not-an-array',
        },
      })

      const { hooks, warnings } = await listCursorHooks({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(hooks.length, 1)
      assert.equal(hooks[0]?.command, './ok.sh')
      assert.equal(warnings.length, 3)
      const messages = warnings.map((w) => w.message)
      assert.ok(messages.some((m) => /entry 2/.test(m) && /"command"/.test(m)))
      assert.ok(messages.some((m) => /entry 3/.test(m) && /"command"/.test(m)))
      assert.ok(messages.some((m) => /beforeMCPExecution.*array/.test(m)))
    })

    it('warns when hooks.json exists but has no hooks object', async () => {
      await writeUserHooks({ version: 1 })
      const { hooks, warnings } = await listCursorHooks({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(hooks.length, 0)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0]?.message ?? '', /no "hooks" object/)
    })

    it('reports no warnings when no hooks.json exists', async () => {
      const { hooks, warnings } = await listCursorHooks({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(hooks.length, 0)
      assert.equal(warnings.length, 0)
    })

    it('discovers project hooks only when the workspace is trusted', async () => {
      await writeProjectHooks({ hooks: { beforeShellExecution: [{ command: './p.sh' }] } })

      const untrusted = await listCursorHooks({ workspaceRoot: tempProject, projectTrusted: false })
      assert.equal(untrusted.hooks.length, 0)

      const trusted = await listCursorHooks({ workspaceRoot: tempProject, projectTrusted: true })
      assert.equal(trusted.hooks.length, 1)
      assert.equal(trusted.hooks[0]?.scope, 'project')
    })

    it('discovers project hooks from the project root but runs them in the thread root', async () => {
      const executionRootPath = join(tempProject, 'thread-checkout')
      const capturedCwd = join(tempHome, 'project-hook-cwd.txt')
      const capturedStdin = join(tempHome, 'project-hook-stdin.json')
      await mkdir(executionRootPath)
      const executionRoot = await realpath(executionRootPath)
      const script = join(tempHome, 'capture-cwd.sh')
      await writeFile(
        script,
        `#!/bin/sh\ncat > '${capturedStdin}'\npwd > '${capturedCwd}'\nprintf '%s' '{"permission":"allow"}'\n`,
        'utf-8',
      )
      await chmod(script, 0o755)
      await writeProjectHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate(
        'run_shell',
        { command: 'true' },
        {
          workspaceRoot: tempProject,
          executionRoot,
          projectTrusted: true,
        },
      )

      assert.equal(decision.permission, 'allow')
      assert.equal((await readFile(capturedCwd, 'utf-8')).trim(), executionRoot)
      const stdin = expectRecord(parseJsonUnknown(await readFile(capturedStdin, 'utf-8')))
      assert.equal(stdin['cwd'], executionRoot)
      assert.deepEqual(stdin['workspace_roots'], [executionRoot])
    })

    it('ignores a malformed hooks.json without throwing, but surfaces a warning', async () => {
      await mkdir(join(tempHome, '.cursor'), { recursive: true })
      await writeFile(userHooksConfigPath(), '{ this is not json', 'utf-8')

      const { hooks, warnings } = await listCursorHooks({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.deepEqual(hooks, [])
      assert.equal(warnings.length, 1)
      assert.match(warnings[0]?.message ?? '', /not valid JSON/)
    })
  })

  describe('tool-gate execution (via the canonical toolGate seam)', () => {
    it('returns allow when no hooks are registered', async () => {
      assert.equal((await gate('run_shell', { command: 'ls' })).permission, 'allow')
    })

    it('denies when a hook returns permission deny (shell)', async () => {
      const script = await writeHookScript(
        'deny.sh',
        '{"permission":"deny","agentMessage":"blocked by policy"}',
      )
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'rm -rf /' })
      assert.equal(decision.permission, 'deny')
      assert.equal(decision.agentMessage, 'blocked by policy')
    })

    it('deny wins over allow when multiple hooks disagree (MCP)', async () => {
      const allow = await writeHookScript('allow.sh', '{"permission":"allow"}')
      const deny = await writeHookScript('deny2.sh', '{"permission":"deny"}')
      await writeUserHooks({
        hooks: { beforeMCPExecution: [{ command: allow }, { command: deny }] },
      })

      assert.equal((await gate('mcp__x__y', {})).permission, 'deny')
    })

    it('fails open to allow when a hook prints no usable JSON (read)', async () => {
      const script = await writeHookScript('garbage.sh', 'not json at all')
      await writeUserHooks({ hooks: { beforeReadFile: [{ command: script }] } })

      assert.equal((await gate('read_file', { path: 'secret.txt' })).permission, 'allow')
    })

    it('only fires the hook whose event matches the gated tool', async () => {
      const readDeny = await writeHookScript('read-deny.sh', '{"permission":"deny"}')
      await writeUserHooks({ hooks: { beforeReadFile: [{ command: readDeny }] } })

      // A read-file hook must not gate a shell command.
      assert.equal((await gate('run_shell', { command: 'ls' })).permission, 'allow')
      assert.equal((await gate('read_file', { path: 'x' })).permission, 'deny')
    })
  })

  // H1 (docs/plans/hooks-and-feature-packs.md): a tool-gate hook may rewrite the
  // tool input via Cursor's `updated_input`, sequentially across hooks; the final
  // rewrite is surfaced on the gate decision (permission-gate then re-runs the
  // policy matrix on it — see permission-gate-hooks.test.ts).
  describe('updatedInput rewrite (H1)', () => {
    it('interprets Cursor `updated_input` into the canonical updatedInput', async () => {
      const script = await writeHookScript(
        'rewrite.sh',
        '{"permission":"allow","updated_input":{"command":"echo safe"}}',
      )
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'echo danger' })
      assert.equal(decision.permission, 'allow')
      assert.deepEqual(decision.updatedInput, { command: 'echo safe' })
    })

    it('ignores a non-object updated_input (a scalar cannot blank the input)', async () => {
      const script = await writeHookScript(
        'bad-rewrite.sh',
        '{"permission":"allow","updated_input":"not-an-object"}',
      )
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'echo hi' })
      assert.equal(decision.permission, 'allow')
      assert.equal(decision.updatedInput, undefined)
    })

    it('threads each rewrite into the next hook`s stdin (sequential pipeline)', async () => {
      // Hook 1 rewrites the command; hook 2 dumps the stdin it received so we can
      // prove it saw hook 1`s rewrite, not the model`s original command.
      const first = await writeHookScript(
        'seq-first.sh',
        '{"permission":"allow","updated_input":{"command":"REWRITTEN_BY_FIRST"}}',
      )
      const dumpPath = join(tempHome, 'second-stdin.json')
      const second = join(tempHome, 'seq-second.sh')
      await writeFile(
        second,
        `#!/bin/sh\ncat > '${dumpPath}'\nprintf '%s' '{"permission":"allow"}'\n`,
      )
      await chmod(second, 0o755)
      await writeUserHooks({
        hooks: { beforeShellExecution: [{ command: first }, { command: second }] },
      })

      const decision = await gate('run_shell', { command: 'ORIGINAL' })
      assert.equal(decision.permission, 'allow')
      // The final threaded input carries the first hook`s rewrite.
      assert.deepEqual(decision.updatedInput, { command: 'REWRITTEN_BY_FIRST' })
      // The second hook`s stdin proves it saw the rewrite, not the original.
      const secondStdin = expectRecord(parseJsonUnknown(await readFile(dumpPath, 'utf-8')))
      assert.equal(secondStdin['command'], 'REWRITTEN_BY_FIRST')
    })
  })

  // H2 (docs/plans/hooks-and-feature-packs.md): a blocking tool-gate hook may
  // inject context into the current turn via Cursor's `additionalContext`. It
  // maps onto the canonical `injectContext`, which `runToolGateHooks` builds into
  // a 10k-capped system-reminder block surfaced on the gate decision.
  describe('injectContext from additionalContext (H2)', () => {
    it('maps `additionalContext` into a current-turn system-reminder block', async () => {
      const script = await writeHookScript(
        'inject.sh',
        '{"permission":"allow","additionalContext":"prefer the repo style guide"}',
      )
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'ls' })
      assert.equal(decision.permission, 'allow')
      assert.equal(
        decision.injectContext,
        '<system-reminder>\nprefer the repo style guide\n</system-reminder>',
      )
    })

    it('accepts the snake_case `additional_context` spelling', async () => {
      const script = await writeHookScript(
        'inject-snake.sh',
        '{"permission":"allow","additional_context":"snake works too"}',
      )
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'ls' })
      assert.match(decision.injectContext ?? '', /snake works too/)
    })

    it('caps injected context at 10k with a truncation note (blob spillover)', async () => {
      // The hook prints a >10k additionalContext; the model-facing block is
      // capped and notes the true full length (the full text lives in the
      // hook`s stdout blob — decision 6 / A3).
      const big = 'X'.repeat(10_500)
      const script = await writeHookScript(
        'inject-big.sh',
        `{"permission":"allow","additionalContext":"${big}"}`,
      )
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'ls' })
      const block = decision.injectContext ?? ''
      assert.ok(block.includes('X'.repeat(10_000)))
      assert.ok(!block.includes('X'.repeat(10_001)))
      assert.match(block, /the first 10000 of 10500 characters/)
      assert.match(block, /preserved in the thread spine/)
    })

    it('drops injected context on a deny (no result to inject into)', async () => {
      const script = await writeHookScript(
        'inject-deny.sh',
        '{"permission":"deny","additionalContext":"never applied"}',
      )
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'ls' })
      assert.equal(decision.permission, 'deny')
      assert.equal(decision.injectContext, undefined)
    })
  })

  describe('per-hook runtime error state (session-deduped)', () => {
    function listUserHooks(): ReturnType<typeof listCursorHooks> {
      return listCursorHooks({ workspaceRoot: null, projectTrusted: false })
    }

    it('records the first invalid-JSON failure and exposes it via listCursorHooks', async () => {
      const script = await writeHookScript('bad-json.sh', 'definitely not json')
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      await gate('run_shell', { command: 'ls' })

      const { hooks } = await listUserHooks()
      assert.equal(hooks.length, 1)
      assert.match(hooks[0]?.lastError ?? '', /invalid JSON/)
    })

    it('records a non-zero exit (crash) as a failure', async () => {
      const path = join(tempHome, 'crash.sh')
      await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
      await chmod(path, 0o755)
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: path }] } })

      await gate('run_shell', { command: 'ls' })

      const { hooks } = await listUserHooks()
      assert.match(hooks[0]?.lastError ?? '', /exited with code 2/)
    })

    it('keeps the first failure per hook per session (dedupe)', async () => {
      const path = join(tempHome, 'flaky.sh')
      await writeFile(path, '#!/bin/sh\ncat > /dev/null\nprintf "not json"\n', 'utf-8')
      await chmod(path, 0o755)
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: path }] } })

      await gate('run_shell', { command: 'ls' })
      await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 3\n', 'utf-8')
      await gate('run_shell', { command: 'ls' })

      const { hooks } = await listUserHooks()
      assert.match(hooks[0]?.lastError ?? '', /invalid JSON/)
    })

    it('is keyed by command+event: the same command failing on one event does not flag another', async () => {
      const script = await writeHookScript('shared-ok.sh', '{"permission":"allow"}')
      const bad = join(tempHome, 'shared-bad.sh')
      await writeFile(bad, '#!/bin/sh\ncat > /dev/null\nexit 1\n', 'utf-8')
      await chmod(bad, 0o755)
      await writeUserHooks({
        hooks: {
          beforeShellExecution: [{ command: bad }],
          beforeMCPExecution: [{ command: script }],
        },
      })

      await gate('run_shell', { command: 'ls' })
      await gate('mcp__x__y', {})

      const { hooks } = await listUserHooks()
      assert.match(hooks.find((h) => h.event === 'beforeShellExecution')?.lastError ?? '', /code 1/)
      assert.equal(hooks.find((h) => h.event === 'beforeMCPExecution')?.lastError, undefined)
    })

    it('a clean run records no error', async () => {
      const script = await writeHookScript('clean.sh', '{"permission":"allow"}')
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      await gate('run_shell', { command: 'ls' })

      const { hooks } = await listUserHooks()
      assert.equal(hooks[0]?.lastError, undefined)
    })
  })

  // Decision 6 (docs/plans/hooks-and-feature-packs.md): every command-hook
  // execution appends a hook_run spine line with raw stdout AND stderr as blobs.
  describe('spine recording of executions (decision 6)', () => {
    const PROJECT = 'proj-cursor-hooks'
    const THREAD = 't1'
    let workspaceDir = ''
    let previousWorkspaceDir: string | undefined

    beforeEach(async () => {
      workspaceDir = await mkdtemp(join(tmpdir(), 'copse-hook-spine-'))
      previousWorkspaceDir = process.env['COPSE_WORKSPACE_DIR']
      process.env['COPSE_WORKSPACE_DIR'] = workspaceDir
      storageSet('activeProjectId', PROJECT)
      beginHookRunRecording(THREAD)
    })

    afterEach(async () => {
      endHookRunRecording(THREAD)
      if (previousWorkspaceDir === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspaceDir
      await rm(workspaceDir, { recursive: true, force: true })
    })

    async function readRecordedRuns(): Promise<SpineHookRunLine[]> {
      // Flushes the store's serialized write queue (recording is fire-and-forget).
      await getThreadMeta(PROJECT, THREAD)
      const raw = await readFile(join(workspaceDir, PROJECT, THREAD, 'events.jsonl'), 'utf-8')
      return parseSpineEntries(raw)
        .map((e) => e.line)
        .filter((l): l is SpineHookRunLine => l?.type === 'hook_run')
    }

    it('captures stderr and exit code alongside the parsed decision', async () => {
      const script = join(tempHome, 'noisy.sh')
      await writeFile(
        script,
        `#!/bin/sh\ncat > /dev/null\necho 'debug noise' >&2\nprintf '%s' '{"permission":"ask"}'\n`,
        'utf-8',
      )
      await chmod(script, 0o755)
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'ls' })
      assert.equal(decision.permission, 'ask')

      const runs = await readRecordedRuns()
      assert.equal(runs.length, 1)
      const [run] = runs
      assert.ok(run)
      assert.equal(run.event, 'beforeShellExecution')
      assert.equal(run.hookId, script)
      assert.equal(run.executor, 'command')
      assert.equal(run.exitCode, 0)
      assert.equal(run.parseOk, true)
      assert.equal(run.decision.permission, 'ask')
      assert.ok(run.durationMs >= 0)
      const dir = join(workspaceDir, PROJECT, THREAD)
      assert.ok(run.stdout && run.stderr)
      assert.equal(await readFile(join(dir, run.stdout.ref), 'utf-8'), '{"permission":"ask"}')
      assert.equal(await readFile(join(dir, run.stderr.ref), 'utf-8'), 'debug noise\n')
    })

    it('flags a rewrite in the hook_run spine decision (H1)', async () => {
      const script = join(tempHome, 'spine-rewrite.sh')
      await writeFile(
        script,
        `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"permission":"allow","updated_input":{"command":"echo safe"}}'\n`,
        'utf-8',
      )
      await chmod(script, 0o755)
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'echo danger' })
      assert.deepEqual(decision.updatedInput, { command: 'echo safe' })

      const runs = await readRecordedRuns()
      const [run] = runs
      assert.ok(run)
      assert.equal(run.decision.updatedInput, true)
      assert.equal(run.decision.permission, 'allow')
    })

    it('records injectContextChars (full length) in the hook_run decision (H2)', async () => {
      const script = join(tempHome, 'spine-inject.sh')
      await writeFile(
        script,
        `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"permission":"allow","additionalContext":"twelve chars"}'\n`,
        'utf-8',
      )
      await chmod(script, 0o755)
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'ls' })
      assert.match(decision.injectContext ?? '', /twelve chars/)

      const runs = await readRecordedRuns()
      const [run] = runs
      assert.ok(run)
      assert.equal(run.decision.injectContextChars, 'twelve chars'.length)
      assert.equal(run.decision.permission, 'allow')
    })

    it('records parse_ok false with the corrupt bytes when stdout is not JSON', async () => {
      const script = join(tempHome, 'corrupt.sh')
      await writeFile(
        script,
        `#!/bin/sh\ncat > /dev/null\nprintf '%s' 'oops not json'\nexit 3\n`,
        'utf-8',
      )
      await chmod(script, 0o755)
      await writeUserHooks({ hooks: { beforeReadFile: [{ command: script }] } })

      // Fail-open semantics are unchanged: the corrupted response allows.
      const decision = await gate('read_file', { path: 'x.txt' })
      assert.equal(decision.permission, 'allow')

      const runs = await readRecordedRuns()
      const [run] = runs
      assert.ok(run)
      assert.equal(run.parseOk, false)
      assert.equal(run.exitCode, 3)
      assert.deepEqual(run.decision, {})
      assert.ok(run.stdout)
      const dir = join(workspaceDir, PROJECT, THREAD)
      assert.equal(await readFile(join(dir, run.stdout.ref), 'utf-8'), 'oops not json')
    })
  })
})
