// Contract tests for the Copse dialect adapter (F1) — pins parse / discovery /
// onFailure / loop_limit / async opt-in / matcher / schema validity, in the
// house style of `cursor-adapter.test.ts` (execution-guidance rule 2).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import { clampLoopLimit } from '@copse/agent/hooks/continuation-budget.ts'
import {
  listCopseHooksForSources,
  userCopseHooksConfigPath,
  listUnsandboxedProjectHooks,
  projectCopseHooksConfigPath,
  copseStopHooks,
  copseAfterFileEditHooks,
  resetCopseHookSessionErrorsForTest,
  COPSE_SUPPORTED_EVENTS,
} from './copse-adapter.ts'
import { runToolGateHooks } from './tool-gate.ts'
import { runAfterFileEditHooks } from './after-file-edit.ts'

/** Fire the canonical toolGate event for a Copse tool call (the production gate path). */
function gate(
  toolName: string,
  args: Record<string, unknown>,
  opts: { workspaceRoot?: string | null; projectTrusted?: boolean } = {},
): ReturnType<typeof runToolGateHooks> {
  return runToolGateHooks(
    { toolName, args },
    { workspaceRoot: opts.workspaceRoot ?? null, projectTrusted: opts.projectTrusted ?? false },
  )
}

describe('copse-adapter (F1)', () => {
  let tempHome = ''
  let tempProject = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-copse-hooks-home-'))
    tempProject = await mkdtemp(join(tmpdir(), 'copse-copse-hooks-proj-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCopseHookSessionErrorsForTest()
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    await rm(tempHome, { recursive: true, force: true })
    await rm(tempProject, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.copse'), { recursive: true })
    await writeFile(userCopseHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  async function writeProjectHooks(config: unknown): Promise<void> {
    await mkdir(join(tempProject, '.copse'), { recursive: true })
    await writeFile(projectCopseHooksConfigPath(tempProject), JSON.stringify(config), 'utf-8')
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
          toolGate: [{ command: './gate.sh' }],
          notARealEvent: [{ command: './nope.sh' }],
        },
      })

      const { hooks, warnings } = await listCopseHooksForSources({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(hooks.length, 1)
      const [hook] = hooks
      assert.ok(hook)
      assert.equal(hook.family, 'copse')
      assert.equal(hook.event, 'toolGate')
      assert.equal(hook.command, './gate.sh')
      assert.equal(hook.scope, 'user')
      assert.equal(hook.supported, true)
      assert.ok(warnings.some((w) => /notARealEvent/.test(w.message)))
    })

    it('badges a known-but-unwired canonical event unsupported', async () => {
      await writeUserHooks({
        hooks: {
          toolGate: [{ command: './gate.sh' }],
          // `compaction` is a real canonical event that has no wired fire site
          // yet (the F2 diff-apply / permission-decision / postTurnReview events
          // are now wired), so it stands in for the "known-but-unwired" case.
          compaction: [{ command: './compact.sh' }],
        },
      })

      const { hooks, warnings } = await listCopseHooksForSources({
        workspaceRoot: null,
        projectTrusted: false,
      })
      // Both are kept (the event is a real canonical event), but only the wired
      // one is supported; the unwired one is badged unsupported + warned.
      assert.equal(hooks.find((h) => h.event === 'toolGate')?.supported, true)
      assert.equal(hooks.find((h) => h.event === 'compaction')?.supported, false)
      assert.ok(
        warnings.some((w) => /compaction/.test(w.message) && /no wired fire site/.test(w.message)),
      )
    })

    it('marks the F2 Copse-native events supported', async () => {
      await writeUserHooks({
        hooks: {
          beforeDiffApply: [{ command: './before-diff.sh' }],
          afterDiffApply: [{ command: './after-diff.sh' }],
          permissionDecision: [{ command: './perm.sh' }],
          postTurnReview: [{ command: './review.sh' }],
        },
      })

      const { hooks } = await listCopseHooksForSources({
        workspaceRoot: null,
        projectTrusted: false,
      })
      for (const event of [
        'beforeDiffApply',
        'afterDiffApply',
        'permissionDecision',
        'postTurnReview',
      ]) {
        assert.equal(hooks.find((h) => h.event === event)?.supported, true, event)
      }
    })

    it('warns on malformed entries without dropping valid ones', async () => {
      await writeUserHooks({
        hooks: {
          toolGate: [{ command: './ok.sh' }, { command: '' }, { notCommand: true }],
          stop: 'not-an-array',
        },
      })

      const { hooks, warnings } = await listCopseHooksForSources({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(hooks.length, 1)
      assert.equal(hooks[0]?.command, './ok.sh')
      const messages = warnings.map((w) => w.message)
      assert.ok(messages.some((m) => /entry 2/.test(m) && /"command"/.test(m)))
      assert.ok(messages.some((m) => /entry 3/.test(m) && /"command"/.test(m)))
      assert.ok(messages.some((m) => /stop.*array/.test(m)))
    })

    it('warns when the file has no hooks object / is invalid JSON', async () => {
      await writeUserHooks({ version: 1 })
      let res = await listCopseHooksForSources({ workspaceRoot: null, projectTrusted: false })
      assert.equal(res.hooks.length, 0)
      assert.ok(res.warnings.some((w) => /no "hooks" object/.test(w.message)))

      await mkdir(join(tempHome, '.copse'), { recursive: true })
      await writeFile(userCopseHooksConfigPath(), '{ not json', 'utf-8')
      res = await listCopseHooksForSources({ workspaceRoot: null, projectTrusted: false })
      assert.equal(res.hooks.length, 0)
      assert.ok(res.warnings.some((w) => /not valid JSON/.test(w.message)))
    })

    it('reports nothing when no config exists', async () => {
      const { hooks, warnings } = await listCopseHooksForSources({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(hooks.length, 0)
      assert.equal(warnings.length, 0)
    })

    it('discovers project hooks only when the workspace is trusted', async () => {
      await writeProjectHooks({ hooks: { toolGate: [{ command: './p.sh' }] } })

      const untrusted = await listCopseHooksForSources({
        workspaceRoot: tempProject,
        projectTrusted: false,
      })
      assert.equal(untrusted.hooks.length, 0)

      const trusted = await listCopseHooksForSources({
        workspaceRoot: tempProject,
        projectTrusted: true,
      })
      assert.equal(trusted.hooks.length, 1)
      assert.equal(trusted.hooks[0]?.scope, 'project')
    })
  })

  describe('field parsing (async / onFailure / sandbox / loop_limit)', () => {
    it('parses onFailure and defaults / warns on an invalid value', async () => {
      await writeUserHooks({
        hooks: {
          stop: [
            { command: './closed.sh', onFailure: 'closed' },
            { command: './bad.sh', onFailure: 'nonsense' },
          ],
        },
      })
      const closed = await copseStopHooks(
        { status: 'completed' },
        { workspaceRoot: null, projectTrusted: false },
      )
      assert.equal(closed.find((h) => h.command === './closed.sh')?.onFailure, 'closed')
      // Invalid onFailure defaults to open, with a warning.
      assert.equal(closed.find((h) => h.command === './bad.sh')?.onFailure, 'open')
      const { warnings } = await listCopseHooksForSources({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.ok(warnings.some((w) => /"onFailure"/.test(w.message)))
    })

    it('parses sandbox:false (F1 escape) and defaults to sandboxed', async () => {
      await writeUserHooks({
        hooks: {
          stop: [{ command: './escape.sh', sandbox: false }, { command: './default.sh' }],
        },
      })
      const hooks = await copseStopHooks(
        { status: 'completed' },
        { workspaceRoot: null, projectTrusted: false },
      )
      assert.equal(hooks.find((h) => h.command === './escape.sh')?.sandbox, false)
      assert.equal(hooks.find((h) => h.command === './default.sh')?.sandbox, true)
    })

    it('surfaces the sandbox:false escape on the Sources summary (F3), omitting it for the default', async () => {
      await writeUserHooks({
        hooks: {
          toolGate: [{ command: './escape.sh', sandbox: false }, { command: './default.sh' }],
        },
      })
      const { hooks } = await listCopseHooksForSources({
        workspaceRoot: null,
        projectTrusted: false,
      })
      // The escape is badged (present + false); the sandboxed-by-default hook omits it.
      assert.equal(hooks.find((h) => h.command === './escape.sh')?.sandbox, false)
      assert.equal('sandbox' in (hooks.find((h) => h.command === './default.sh') ?? {}), false)
    })

    it('honours async:true on afterFileEdit but rejects it on a decision event', async () => {
      await writeUserHooks({
        hooks: {
          afterFileEdit: [{ command: './fmt.sh', async: true }],
          toolGate: [{ command: './gate.sh', async: true }],
        },
      })
      const edit = await copseAfterFileEditHooks(
        { filePath: '/abs/x.ts' },
        { workspaceRoot: null, projectTrusted: false },
      )
      assert.equal(edit.async.length, 1)
      assert.equal(edit.blocking.length, 0)
      assert.equal(edit.async[0]?.async, true)

      const { warnings } = await listCopseHooksForSources({
        workspaceRoot: null,
        projectTrusted: false,
      })
      // async:true on the blocking decision event `toolGate` is warned + ignored.
      assert.ok(warnings.some((w) => /"async: true" is not allowed/.test(w.message)))
    })

    it('parses loop_limit and warns-then-clamps a null (unlimited) value', async () => {
      await writeUserHooks({
        hooks: {
          stop: [
            { command: './bounded.sh', loop_limit: 2 },
            { command: './unlimited.sh', loop_limit: null },
            { command: './bad.sh', loop_limit: -1 },
          ],
        },
      })
      const hooks = await copseStopHooks(
        { status: 'completed' },
        { workspaceRoot: null, projectTrusted: false },
      )
      assert.equal(hooks.find((h) => h.command === './bounded.sh')?.loopLimit, 2)
      assert.equal(hooks.find((h) => h.command === './unlimited.sh')?.loopLimit, null)
      // A negative loop_limit is ignored (no field carried).
      assert.equal(hooks.find((h) => h.command === './bad.sh')?.loopLimit, undefined)

      const { warnings } = await listCopseHooksForSources({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.ok(warnings.some((w) => /loop_limit: null/.test(w.message)))
      assert.ok(warnings.some((w) => /non-negative integer/.test(w.message)))
    })

    it('applies a parsed loop_limit tighten-only via clampLoopLimit (decision 5)', async () => {
      await writeUserHooks({ hooks: { stop: [{ command: './bounded.sh', loop_limit: 2 }] } })
      const [hook] = await copseStopHooks(
        { status: 'completed' },
        { workspaceRoot: null, projectTrusted: false },
      )
      assert.ok(hook)
      const limit = hook.loopLimit
      assert.ok(typeof limit === 'number')
      assert.equal(limit, 2)
      // Tighten-only: min(loop_limit=2, remaining=5) = 2; and never above remaining.
      assert.equal(clampLoopLimit(limit, 0).limit, 2)
      assert.equal(clampLoopLimit(limit, 4).limit, 1)
      // null (unlimited) is clamped to the global remaining with a warning.
      const clampedNull = clampLoopLimit(null, 0)
      assert.equal(clampedNull.limit, 5)
      assert.equal(clampedNull.clampedFromNull, true)
    })
  })

  describe('tool-gate execution (via the canonical toolGate seam)', () => {
    it('returns allow when no hooks are registered', async () => {
      assert.equal((await gate('run_shell', { command: 'ls' })).permission, 'allow')
    })

    it('denies when a hook returns decision deny with the canonical vocabulary', async () => {
      const script = await writeHookScript(
        'deny.sh',
        '{"decision":"deny","agentMessage":"blocked by policy"}',
      )
      await writeUserHooks({ hooks: { toolGate: [{ command: script }] } })

      const decision = await gate('run_shell', { command: 'rm -rf /' })
      assert.equal(decision.permission, 'deny')
      assert.equal(decision.agentMessage, 'blocked by policy')
    })

    it('deny wins when multiple hooks disagree', async () => {
      const allow = await writeHookScript('allow.sh', '{"decision":"allow"}')
      const deny = await writeHookScript('deny2.sh', '{"decision":"deny"}')
      await writeUserHooks({ hooks: { toolGate: [{ command: allow }, { command: deny }] } })
      assert.equal((await gate('mcp__x__y', {})).permission, 'deny')
    })

    it('fails OPEN by default when a hook crashes', async () => {
      const script = await writeHookScript('boom.sh', '')
      // Overwrite with a script that exits non-zero.
      await writeFile(script, '#!/bin/sh\ncat > /dev/null\nexit 3\n', 'utf-8')
      await chmod(script, 0o755)
      await writeUserHooks({ hooks: { toolGate: [{ command: script }] } })
      assert.equal((await gate('run_shell', { command: 'ls' })).permission, 'allow')
    })

    it('fails CLOSED (blocks) when onFailure:closed and the hook crashes (decision 9)', async () => {
      const script = join(tempHome, 'crash.sh')
      await writeFile(script, '#!/bin/sh\ncat > /dev/null\nexit 3\n', 'utf-8')
      await chmod(script, 0o755)
      await writeUserHooks({ hooks: { toolGate: [{ command: script, onFailure: 'closed' }] } })
      const decision = await gate('run_shell', { command: 'ls' })
      assert.equal(decision.permission, 'deny')
    })

    it('honours a per-hook matcher against the tool name', async () => {
      const deny = await writeHookScript('m-deny.sh', '{"decision":"deny"}')
      await writeUserHooks({ hooks: { toolGate: [{ command: deny, matcher: '^run_shell$' }] } })
      // Matches run_shell → deny; does not match read_file → allow.
      assert.equal((await gate('run_shell', { command: 'ls' })).permission, 'deny')
      assert.equal((await gate('read_file', { path: 'x' })).permission, 'allow')
    })

    it('maps continue:false onto a halt (decision 12)', async () => {
      const script = await writeHookScript('halt.sh', '{"continue":false,"userMessage":"stop now"}')
      await writeUserHooks({ hooks: { toolGate: [{ command: script }] } })
      const decision = await gate('run_shell', { command: 'ls' })
      assert.equal(decision.permission, 'deny')
      assert.equal(decision.haltRun?.reason, 'stop now')
    })
  })

  describe('afterFileEdit async opt-in (F1 + C1)', () => {
    it('dispatches a Copse async afterFileEdit hook detached and runs it', async () => {
      const marker = join(tempHome, 'async-ran.marker')
      const script = join(tempHome, 'async-fmt.sh')
      await writeFile(
        script,
        `#!/bin/sh\ncat > /dev/null\ntouch '${marker}'\nprintf '%s' '{}'\n`,
        'utf-8',
      )
      await chmod(script, 0o755)
      await writeUserHooks({ hooks: { afterFileEdit: [{ command: script, async: true }] } })

      const result = await runAfterFileEditHooks('/abs/edited.ts', {
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(result.ran, 1)
      assert.equal(result.async, 1)
      // Detached: the marker only exists after the settled test-affordance resolves.
      await result.settled
      assert.equal(existsSync(marker), true)
    })

    it('runs a blocking (non-async) afterFileEdit hook awaited', async () => {
      const marker = join(tempHome, 'blocking-ran.marker')
      const script = join(tempHome, 'blocking-fmt.sh')
      await writeFile(
        script,
        `#!/bin/sh\ncat > /dev/null\ntouch '${marker}'\nprintf '%s' '{}'\n`,
        'utf-8',
      )
      await chmod(script, 0o755)
      await writeUserHooks({ hooks: { afterFileEdit: [{ command: script }] } })

      const result = await runAfterFileEditHooks('/abs/edited.ts', {
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(result.ran, 1)
      assert.equal(result.async, 0)
      // Blocking: the marker already exists once the call resolves (awaited).
      assert.equal(existsSync(marker), true)
    })
  })

  describe('published JSON schema', () => {
    it('is valid JSON and enumerates exactly the wired canonical events', async () => {
      const schemaPath = join(process.cwd(), 'schemas', 'copse-hooks.schema.json')
      await stat(schemaPath) // exists
      const schema = expectRecord(parseJsonUnknown(await readFile(schemaPath, 'utf-8')))
      assert.ok(
        typeof schema['$schema'] === 'string' && schema['$schema'].includes('json-schema.org'),
      )
      assert.ok(typeof schema['$id'] === 'string' && schema['$id'].length > 0)
      assert.ok(typeof schema['title'] === 'string')

      // Drift guard: the schema's hook event keys must match the adapter's
      // supported set exactly, so a new wired event forces a schema edit.
      const schemaProperties = expectRecord(schema['properties'])
      const hooks = expectRecord(schemaProperties['hooks'])
      const eventKeys = Object.keys(expectRecord(hooks['properties'])).sort()
      assert.deepEqual(eventKeys, [...COPSE_SUPPORTED_EVENTS].sort())

      // onFailure enum matches the decision-9 vocabulary.
      const definitions = expectRecord(schema['$defs'])
      const hook = expectRecord(definitions['hook'])
      const hookProperties = expectRecord(hook['properties'])
      const onFailure = expectRecord(hookProperties['onFailure'])
      assert.deepEqual(onFailure['enum'], ['open', 'closed'])
    })
  })
})

describe('listUnsandboxedProjectHooks — trust-prompt surfacing (decision 7 / F3)', () => {
  let proj = ''
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), 'copse-unsandboxed-proj-'))
  })
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true })
  })

  async function writeProject(config: unknown): Promise<void> {
    await mkdir(join(proj, '.copse'), { recursive: true })
    await writeFile(projectCopseHooksConfigPath(proj), JSON.stringify(config), 'utf-8')
  }

  it('lists only the sandbox:false entries, independent of workspace trust', async () => {
    await writeProject({
      hooks: {
        toolGate: [{ command: 'audit.sh' }, { command: 'escape.sh', sandbox: false }],
        stop: [{ command: 'notify.sh', sandbox: false }],
      },
    })
    // No trust flag is consulted anywhere — the consent prompt must see this
    // BEFORE the workspace is trusted.
    const unsandboxed = await listUnsandboxedProjectHooks(proj)
    assert.deepEqual(unsandboxed.map((h) => `${h.event}:${h.command}`).sort(), [
      'stop:notify.sh',
      'toolGate:escape.sh',
    ])
  })

  it('returns [] for a missing or hook-free project config', async () => {
    assert.deepEqual(await listUnsandboxedProjectHooks(proj), [])
    await writeProject({ hooks: { toolGate: [{ command: 'sandboxed.sh' }] } })
    assert.deepEqual(await listUnsandboxedProjectHooks(proj), [])
  })
})
