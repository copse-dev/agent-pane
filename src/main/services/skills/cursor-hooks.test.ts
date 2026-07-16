import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listCursorHooks,
  runPermissionHooks,
  userHooksConfigPath,
  projectHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
} from './cursor-hooks.ts'
import { beginHookRunRecording, endHookRunRecording } from '../hook-run-recorder.ts'
import { getThreadMeta } from '../thread-store.ts'
import { storageSet } from '../storage/storage.ts'
import { parseSpineEntries, type SpineHookRunLine } from '@shared/threads/spine-schema.ts'

describe('cursor-hooks', () => {
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

  it('lists user hooks and skips unknown events with a warning', async () => {
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

  it('marks declared-but-unwired events as unsupported', async () => {
    await writeUserHooks({
      hooks: {
        beforeShellExecution: [{ command: './gate.sh' }],
        stop: [{ command: './notify.sh' }],
      },
    })

    const { hooks, warnings } = await listCursorHooks({
      workspaceRoot: null,
      projectTrusted: false,
    })
    assert.equal(warnings.length, 0)
    const stopHook = hooks.find((h) => h.event === 'stop')
    assert.ok(stopHook)
    assert.equal(stopHook.supported, false)
    const gateHook = hooks.find((h) => h.event === 'beforeShellExecution')
    assert.ok(gateHook)
    assert.equal(gateHook.supported, true)
  })

  it('warns on malformed entries (bad shape / empty command) without dropping valid ones', async () => {
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

    const untrusted = await listCursorHooks({
      workspaceRoot: tempProject,
      projectTrusted: false,
    })
    assert.equal(untrusted.hooks.length, 0)

    const trusted = await listCursorHooks({ workspaceRoot: tempProject, projectTrusted: true })
    assert.equal(trusted.hooks.length, 1)
    const [projectHook] = trusted.hooks
    assert.ok(projectHook)
    assert.equal(projectHook.scope, 'project')
  })

  it('returns allow when no hooks are registered', async () => {
    const decision = await runPermissionHooks(
      'beforeShellExecution',
      { command: 'ls' },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'allow')
  })

  it('denies when a hook returns permission deny', async () => {
    const script = await writeHookScript(
      'deny.sh',
      '{"permission":"deny","agentMessage":"blocked by policy"}',
    )
    await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

    const decision = await runPermissionHooks(
      'beforeShellExecution',
      { command: 'rm -rf /' },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'deny')
    assert.equal(decision.agentMessage, 'blocked by policy')
  })

  it('deny wins over allow when multiple hooks disagree', async () => {
    const allow = await writeHookScript('allow.sh', '{"permission":"allow"}')
    const deny = await writeHookScript('deny2.sh', '{"permission":"deny"}')
    await writeUserHooks({
      hooks: { beforeMCPExecution: [{ command: allow }, { command: deny }] },
    })

    const decision = await runPermissionHooks(
      'beforeMCPExecution',
      { tool_name: 'mcp__x__y', tool_input: {} },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'deny')
  })

  it('fails open to allow when a hook prints no usable JSON', async () => {
    const script = await writeHookScript('garbage.sh', 'not json at all')
    await writeUserHooks({ hooks: { beforeReadFile: [{ command: script }] } })

    const decision = await runPermissionHooks(
      'beforeReadFile',
      { file_path: 'secret.txt', content: '' },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'allow')
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
    assert.equal(warnings[0]?.source, userHooksConfigPath())
  })

  describe('per-hook runtime error state (session-deduped)', () => {
    function listUserHooks(): ReturnType<typeof listCursorHooks> {
      return listCursorHooks({ workspaceRoot: null, projectTrusted: false })
    }

    it('records the first invalid-JSON failure and exposes it via listCursorHooks', async () => {
      const script = await writeHookScript('bad-json.sh', 'definitely not json')
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      await runPermissionHooks(
        'beforeShellExecution',
        { command: 'ls' },
        { workspaceRoot: null, projectTrusted: false },
      )

      const { hooks } = await listUserHooks()
      assert.equal(hooks.length, 1)
      assert.match(hooks[0]?.lastError ?? '', /invalid JSON/)
    })

    it('records a non-zero exit (crash) as a failure', async () => {
      const path = join(tempHome, 'crash.sh')
      await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
      await chmod(path, 0o755)
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: path }] } })

      await runPermissionHooks(
        'beforeShellExecution',
        { command: 'ls' },
        { workspaceRoot: null, projectTrusted: false },
      )

      const { hooks } = await listUserHooks()
      assert.match(hooks[0]?.lastError ?? '', /exited with code 2/)
    })

    it('keeps the first failure per hook per session (dedupe)', async () => {
      const path = join(tempHome, 'flaky.sh')
      await writeFile(path, '#!/bin/sh\ncat > /dev/null\nprintf "not json"\n', 'utf-8')
      await chmod(path, 0o755)
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: path }] } })

      await runPermissionHooks(
        'beforeShellExecution',
        { command: 'ls' },
        { workspaceRoot: null, projectTrusted: false },
      )
      // Second run fails differently (crash); the recorded error must not change.
      await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 3\n', 'utf-8')
      await runPermissionHooks(
        'beforeShellExecution',
        { command: 'ls' },
        { workspaceRoot: null, projectTrusted: false },
      )

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

      await runPermissionHooks(
        'beforeShellExecution',
        { command: 'ls' },
        { workspaceRoot: null, projectTrusted: false },
      )
      await runPermissionHooks(
        'beforeMCPExecution',
        { tool_name: 'mcp__x__y', tool_input: {} },
        { workspaceRoot: null, projectTrusted: false },
      )

      const { hooks } = await listUserHooks()
      const shellHook = hooks.find((h) => h.event === 'beforeShellExecution')
      const mcpHook = hooks.find((h) => h.event === 'beforeMCPExecution')
      assert.match(shellHook?.lastError ?? '', /exited with code 1/)
      assert.equal(mcpHook?.lastError, undefined)
    })

    it('a clean run records no error', async () => {
      const script = await writeHookScript('clean.sh', '{"permission":"allow"}')
      await writeUserHooks({ hooks: { beforeShellExecution: [{ command: script }] } })

      await runPermissionHooks(
        'beforeShellExecution',
        { command: 'ls' },
        { workspaceRoot: null, projectTrusted: false },
      )

      const { hooks } = await listUserHooks()
      assert.equal(hooks[0]?.lastError, undefined)
    })
  })

  // Decision 6 (docs/plans/hooks-and-feature-packs.md): every command-hook
  // execution appends a hook_run spine line with raw stdout AND stderr as
  // blobs — stderr was previously discarded via stdio 'ignore'.
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

      const decision = await runPermissionHooks(
        'beforeShellExecution',
        { command: 'ls' },
        { workspaceRoot: null, projectTrusted: false },
      )
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
      const decision = await runPermissionHooks(
        'beforeReadFile',
        { file_path: 'x.txt', content: '' },
        { workspaceRoot: null, projectTrusted: false },
      )
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
