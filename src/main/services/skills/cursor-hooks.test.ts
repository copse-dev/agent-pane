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

  it('lists user hooks and skips unknown events', async () => {
    await writeUserHooks({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: './audit.sh' }],
        notARealEvent: [{ command: './nope.sh' }],
      },
    })

    const hooks = await listCursorHooks({ workspaceRoot: null, projectTrusted: false })
    assert.equal(hooks.length, 1)
    const [hook] = hooks
    assert.ok(hook)
    assert.equal(hook.event, 'beforeShellExecution')
    assert.equal(hook.command, './audit.sh')
    assert.equal(hook.scope, 'user')
  })

  it('discovers project hooks only when the workspace is trusted', async () => {
    await writeProjectHooks({ hooks: { beforeShellExecution: [{ command: './p.sh' }] } })

    const untrusted = await listCursorHooks({
      workspaceRoot: tempProject,
      projectTrusted: false,
    })
    assert.equal(untrusted.length, 0)

    const trusted = await listCursorHooks({ workspaceRoot: tempProject, projectTrusted: true })
    assert.equal(trusted.length, 1)
    const [projectHook] = trusted
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

  it('ignores a malformed hooks.json without throwing', async () => {
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(userHooksConfigPath(), '{ this is not json', 'utf-8')

    const hooks = await listCursorHooks({ workspaceRoot: null, projectTrusted: false })
    assert.deepEqual(hooks, [])
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
