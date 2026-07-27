import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  claudeAdapter,
  claudeMatcherMatches,
  claudeSessionStartHooks,
  listClaudeHooks,
  userClaudeSettingsPath,
  projectClaudeSettingsPath,
  projectClaudeLocalSettingsPath,
  CLAUDE_DEFAULT_HOOK_TIMEOUT_MS,
} from './claude-adapter.ts'
import type { CommandHook } from '@copse/agent/hooks/command-executor.ts'
import { runToolGateHooks } from './tool-gate.ts'
import { resetCursorHookSessionErrorsForTest } from './cursor-adapter.ts'
import { expectRecord } from '@shared/unknown-value.ts'

/** Fire the canonical toolGate event for a Copse tool call (the production gate path). */
function gate(
  toolName: string,
  args: Record<string, unknown>,
): ReturnType<typeof runToolGateHooks> {
  return runToolGateHooks({ toolName, args }, { workspaceRoot: null, projectTrusted: false })
}

describe('claude-adapter', () => {
  let tempHome = ''
  let tempProject = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-claude-hooks-home-'))
    tempProject = await mkdtemp(join(tmpdir(), 'copse-claude-hooks-proj-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    await rm(tempHome, { recursive: true, force: true })
    await rm(tempProject, { recursive: true, force: true })
  })

  async function writeUserSettings(config: unknown): Promise<void> {
    const path = userClaudeSettingsPath()
    await mkdir(join(tempHome, '.claude'), { recursive: true })
    await writeFile(path, JSON.stringify(config), 'utf-8')
  }

  async function writeProjectSettings(config: unknown): Promise<void> {
    await mkdir(join(tempProject, '.claude'), { recursive: true })
    await writeFile(projectClaudeSettingsPath(tempProject), JSON.stringify(config), 'utf-8')
  }

  async function writeLocalSettings(config: unknown): Promise<void> {
    await mkdir(join(tempProject, '.claude'), { recursive: true })
    await writeFile(projectClaudeLocalSettingsPath(tempProject), JSON.stringify(config), 'utf-8')
  }

  /** Write an executable shell script that prints `responseJson` on stdout and exits 0. */
  async function writeJsonHookScript(name: string, responseJson: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${responseJson}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  /** Write a hook that exits 2 with a stderr reason (Claude blocking signal). */
  async function writeExit2HookScript(name: string, stderrMsg: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(
      path,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${stderrMsg}' >&2\nexit 2\n`,
      'utf-8',
    )
    await chmod(path, 0o755)
    return path
  }

  describe('claudeMatcherMatches', () => {
    it('treats empty / * as match-all', () => {
      assert.equal(claudeMatcherMatches(undefined, 'Bash'), true)
      assert.equal(claudeMatcherMatches('', 'Bash'), true)
      assert.equal(claudeMatcherMatches('*', 'Read'), true)
    })

    it('exact-matches pipe-separated alternatives', () => {
      assert.equal(claudeMatcherMatches('Bash', 'Bash'), true)
      assert.equal(claudeMatcherMatches('Bash', 'Read'), false)
      assert.equal(claudeMatcherMatches('Edit|Write', 'Write'), true)
      assert.equal(claudeMatcherMatches('Edit|Write', 'Bash'), false)
    })

    it('uses RegExp when the matcher has special characters', () => {
      assert.equal(claudeMatcherMatches('mcp__.*', 'mcp__memory__get'), true)
      assert.equal(claudeMatcherMatches('mcp__.*', 'Bash'), false)
      assert.equal(claudeMatcherMatches('^Read$', 'Read'), true)
      assert.equal(claudeMatcherMatches('^Read$', 'NotebookRead'), false)
    })
  })

  describe('discovery', () => {
    it('lists user PreToolUse command hooks and skips non-command handlers', async () => {
      await writeUserSettings({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: './audit.sh' },
                { type: 'prompt', prompt: 'ignore me' },
              ],
            },
          ],
          PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './nope.sh' }] }],
        },
      })

      const { hooks, warnings } = await listClaudeHooks({
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(hooks.length, 1)
      const [hook] = hooks
      assert.ok(hook)
      assert.equal(hook.family, 'claude')
      assert.equal(hook.event, 'PreToolUse')
      assert.equal(hook.matcher, 'Bash')
      assert.equal(hook.command, './audit.sh')
      assert.equal(hook.scope, 'user')
      // G3 warn-level lint: a declared-but-unwired vendor event is skipped WITH a
      // warning (never a load gate — the PreToolUse hook still loaded above).
      const postToolWarning = warnings.find((w) => w.event === 'PostToolUse')
      assert.ok(postToolWarning, 'expected a warning for the unsupported PostToolUse event')
      assert.match(postToolWarning.message, /not supported by Copse/)
    })

    it('warns (warn-only, never a gate) on unknown vs recognised-unsupported events', async () => {
      await writeUserSettings({
        hooks: {
          // Recognised by the vendored Claude schema, unsupported by Copse.
          Notification: [{ hooks: [{ type: 'command', command: './notify.sh' }] }],
          // Not a real Claude event — a typo.
          PreToolUseTypo: [{ hooks: [{ type: 'command', command: './typo.sh' }] }],
          // Wired event still loads normally alongside the warnings.
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './ok.sh' }] }],
        },
      })

      const { hooks, warnings } = await listClaudeHooks({
        workspaceRoot: null,
        projectTrusted: false,
      })
      // The valid hook loaded despite the two bad events — the lint never gates.
      assert.equal(hooks.length, 1)
      assert.equal(hooks[0]?.event, 'PreToolUse')

      const recognised = warnings.find((w) => w.event === 'Notification')
      assert.ok(recognised)
      assert.match(recognised.message, /recognised by Claude Code but not supported/)

      const unknown = warnings.find((w) => w.event === 'PreToolUseTypo')
      assert.ok(unknown)
      assert.match(unknown.message, /Unknown Claude hook event/)
    })

    it('discovers project and local settings only when the workspace is trusted', async () => {
      await writeProjectSettings({
        hooks: {
          PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: './p.sh' }] }],
        },
      })
      await writeLocalSettings({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: './local.sh' }] }] },
      })

      const untrusted = await listClaudeHooks({ workspaceRoot: tempProject, projectTrusted: false })
      assert.equal(untrusted.hooks.length, 0)

      const trusted = await listClaudeHooks({ workspaceRoot: tempProject, projectTrusted: true })
      assert.equal(trusted.hooks.length, 2)
      assert.ok(trusted.hooks.every((h) => h.scope === 'project'))
    })
  })

  describe('tool-gate execution (exit-code table, decision 9)', () => {
    it('returns allow when no hooks match the tool', async () => {
      await writeUserSettings({
        hooks: {
          PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: './x.sh' }] }],
        },
      })
      assert.equal((await gate('run_shell', { command: 'ls' })).permission, 'allow')
    })

    it('denies when a hook returns permissionDecision deny', async () => {
      const script = await writeJsonHookScript(
        'deny.sh',
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked by policy"}}',
      )
      await writeUserSettings({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: script }] }] },
      })

      const decision = await gate('run_shell', { command: 'rm -rf /' })
      assert.equal(decision.permission, 'deny')
      assert.equal(decision.agentMessage, 'blocked by policy')
    })

    // H2 (docs/plans/hooks-and-feature-packs.md): Claude's PreToolUse
    // `hookSpecificOutput.additionalContext` injects into the current turn.
    it('maps hookSpecificOutput.additionalContext into a system-reminder block (H2)', async () => {
      const script = await writeJsonHookScript(
        'inject.sh',
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"consult the runbook"}}',
      )
      await writeUserSettings({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: script }] }] },
      })

      const decision = await gate('run_shell', { command: 'ls' })
      assert.equal(decision.permission, 'allow')
      assert.equal(
        decision.injectContext,
        '<system-reminder>\nconsult the runbook\n</system-reminder>',
      )
    })

    it('injects context alongside an allow permissionDecision (H2)', async () => {
      const script = await writeJsonHookScript(
        'allow-inject.sh',
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"note this"}}',
      )
      await writeUserSettings({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: script }] }] },
      })

      const decision = await gate('run_shell', { command: 'ls' })
      assert.equal(decision.permission, 'allow')
      assert.match(decision.injectContext ?? '', /note this/)
    })

    it('denies on exit code 2 and surfaces stderr', async () => {
      const script = await writeExit2HookScript('exit2.sh', 'exit-2-block')
      await writeUserSettings({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: script }] }] },
      })

      const decision = await gate('run_shell', { command: 'echo hi' })
      assert.equal(decision.permission, 'deny')
      assert.equal(decision.agentMessage, 'exit-2-block')
    })

    it('deny wins over allow when multiple hooks disagree', async () => {
      const allow = await writeJsonHookScript(
        'allow.sh',
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}',
      )
      const deny = await writeJsonHookScript(
        'deny2.sh',
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}',
      )
      await writeUserSettings({
        hooks: {
          PreToolUse: [
            { matcher: 'mcp__.*', hooks: [{ type: 'command', command: allow }] },
            { matcher: 'mcp__x__y', hooks: [{ type: 'command', command: deny }] },
          ],
        },
      })

      assert.equal((await gate('mcp__x__y', { q: 1 })).permission, 'deny')
    })

    it('fails open on non-JSON stdout', async () => {
      const script = await writeJsonHookScript('bad.sh', 'not-json')
      await writeUserSettings({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: script }] }] },
      })

      assert.equal((await gate('read_file', { path: 'a.ts' })).permission, 'allow')
    })
  })

  // H4 (B4 readiness): SessionStart is the one Claude agent-session event that
  // carries an **optional `model`**. It is discovered + marshalled fire-and-forget.
  describe('sessionStart (H4)', () => {
    const SESSION_HOOK: CommandHook<'sessionStart'> = {
      id: 'ss',
      event: 'sessionStart',
      executor: 'command',
      dialect: 'claude',
      command: './ss.sh',
      onFailure: 'open',
    }

    it('discovers a SessionStart hook (matching the `startup` source)', async () => {
      await writeUserSettings({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: './ss.sh' }] }] },
      })
      const hooks = await claudeSessionStartHooks(
        { firstTurn: true },
        { workspaceRoot: null, projectTrusted: false },
      )
      assert.equal(hooks.length, 1)
      const [hook] = hooks
      assert.ok(hook)
      assert.equal(hook.event, 'sessionStart')
      assert.equal(hook.timeoutMs, CLAUDE_DEFAULT_HOOK_TIMEOUT_MS)
    })

    it('skips a SessionStart hook whose matcher source excludes `startup`', async () => {
      await writeUserSettings({
        hooks: {
          SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: './ss.sh' }] }],
        },
      })
      const hooks = await claudeSessionStartHooks(
        { firstTurn: true },
        { workspaceRoot: null, projectTrusted: false },
      )
      assert.equal(hooks.length, 0)
    })

    it('marshals the optional `model` only when the session resolved one', () => {
      const marshal = claudeAdapter.marshalSessionStartRequest?.bind(claudeAdapter)
      assert.ok(marshal)
      const withModel = expectRecord(
        marshal(
          SESSION_HOOK,
          { firstTurn: true },
          {
            conversationId: 'c1',
            generationId: 'g1',
            model: { model: 'claude-sonnet-4', modelId: 'claude-sonnet-4', modelParams: [] },
          },
        ),
      )
      assert.equal(withModel['hook_event_name'], 'SessionStart')
      assert.equal(withModel['source'], 'startup')
      assert.equal(withModel['session_id'], 'c1')
      assert.equal(withModel['model'], 'claude-sonnet-4')

      const withoutModel = expectRecord(
        marshal(
          SESSION_HOOK,
          { firstTurn: true },
          {
            conversationId: 'c1',
            generationId: 'g1',
          },
        ),
      )
      assert.equal('model' in withoutModel, false)
    })
  })
})
