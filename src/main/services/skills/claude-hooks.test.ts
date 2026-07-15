import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  claudeMatcherMatches,
  listClaudeHooks,
  runClaudePreToolUseHooks,
  userClaudeSettingsPath,
  projectClaudeSettingsPath,
  projectClaudeLocalSettingsPath,
} from './claude-hooks.ts'

describe('claude-hooks', () => {
  let tempHome = ''
  let tempProject = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-claude-hooks-home-'))
    tempProject = await mkdtemp(join(tmpdir(), 'copse-claude-hooks-proj-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
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

    const hooks = await listClaudeHooks({ workspaceRoot: null, projectTrusted: false })
    assert.equal(hooks.length, 1)
    const [hook] = hooks
    assert.ok(hook)
    assert.equal(hook.family, 'claude')
    assert.equal(hook.event, 'PreToolUse')
    assert.equal(hook.matcher, 'Bash')
    assert.equal(hook.command, './audit.sh')
    assert.equal(hook.scope, 'user')
  })

  it('discovers project and local settings only when the workspace is trusted', async () => {
    await writeProjectSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: './p.sh' }] }],
      },
    })
    await writeLocalSettings({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: './local.sh' }] }],
      },
    })

    const untrusted = await listClaudeHooks({
      workspaceRoot: tempProject,
      projectTrusted: false,
    })
    assert.equal(untrusted.length, 0)

    const trusted = await listClaudeHooks({ workspaceRoot: tempProject, projectTrusted: true })
    assert.equal(trusted.length, 2)
    assert.ok(trusted.every((h) => h.scope === 'project'))
  })

  it('returns allow when no hooks match', async () => {
    await writeUserSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: './x.sh' }] }],
      },
    })
    const decision = await runClaudePreToolUseHooks(
      'Bash',
      { command: 'ls' },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'allow')
  })

  it('denies when a hook returns permissionDecision deny', async () => {
    const script = await writeJsonHookScript(
      'deny.sh',
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked by policy"}}',
    )
    await writeUserSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: script }] }],
      },
    })

    const decision = await runClaudePreToolUseHooks(
      'Bash',
      { command: 'rm -rf /' },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'deny')
    assert.equal(decision.agentMessage, 'blocked by policy')
  })

  it('denies on exit code 2 and surfaces stderr', async () => {
    const script = await writeExit2HookScript('exit2.sh', 'exit-2-block')
    await writeUserSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: script }] }],
      },
    })

    const decision = await runClaudePreToolUseHooks(
      'Bash',
      { command: 'echo hi' },
      { workspaceRoot: null, projectTrusted: false },
    )
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

    const decision = await runClaudePreToolUseHooks(
      'mcp__x__y',
      { q: 1 },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'deny')
  })

  it('fails open on non-JSON stdout', async () => {
    const script = await writeJsonHookScript('bad.sh', 'not-json')
    await writeUserSettings({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: script }] }],
      },
    })

    const decision = await runClaudePreToolUseHooks(
      'Read',
      { file_path: 'a.ts' },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'allow')
  })
})
