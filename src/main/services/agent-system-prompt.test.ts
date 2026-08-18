import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSystemPrompt } from './agent-system-prompt.ts'
import { OPUS_5_RESPONSE_LENGTH_BLOCK, OPUS_5_TONE_REMINDER } from './agent-prompt.ts'
import { setSetting } from './storage/settings.test-shim.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import { runWithThreadExecutionContext, type ThreadExecutionContext } from './thread-execution-context.ts'

const CONCISENESS = 'Keep responses focused, brief, and concise'

describe('buildSystemPrompt Opus 5 conciseness steering', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setSetting('skillsEnabled', false)
    setSetting('skillPluginPaths', [])
    setSetting('customInstructions', '')
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-system-prompt-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  const build = (model?: string): Promise<string> =>
    buildSystemPrompt({
      subagentsEnabled: false,
      invokedSkills: [],
      ...(model === undefined ? {} : { model }),
    })

  it('adds the length instruction and the paired tail reminder on Opus 5', async () => {
    const prompt = await build('claude-opus-5')
    assert.ok(prompt.includes(CONCISENESS))
    assert.ok(prompt.includes('<tone_preference>'))
    // The instruction lands early; the reminder restates it near the end.
    assert.ok(prompt.indexOf(CONCISENESS) < prompt.indexOf('<tone_preference>'))
  })

  it('matches dated Opus 5 snapshots', async () => {
    const prompt = await build('claude-opus-5-20260101')
    assert.ok(prompt.includes(CONCISENESS))
  })

  it('steers Opus 5 the same way whichever provider routes to it', async () => {
    // The picker hands `buildSystemPrompt` its own routed id, not a bare model
    // id — the same value `resolveContextWindow` unwraps.
    for (const model of ['openrouter:anthropic/claude-opus-5', 'my-proxy:claude-opus-5']) {
      const prompt = await build(model)
      assert.ok(prompt.includes(CONCISENESS), `missing length steering for ${model}`)
    }
  })

  it('leaves every other model — and an unpinned model — untouched', async () => {
    for (const model of [
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'gpt-5.6-sol',
      'openrouter:anthropic/claude-opus-4-8',
      'lmstudio:claude-opus-5-distill-q4',
      undefined,
    ]) {
      const label = model ?? '(no model pinned)'
      const prompt = await build(model)
      assert.ok(!prompt.includes(CONCISENESS), `unexpected length steering for ${label}`)
      assert.ok(!prompt.includes('<tone_preference>'), `unexpected tone reminder for ${label}`)
    }
  })

  it('keeps the tone reminder ahead of custom instructions so users can override it', async () => {
    setSetting('customInstructions', 'Always walk me through your reasoning in full detail.')
    const prompt = await build('claude-opus-5')
    assert.ok(prompt.indexOf('<tone_preference>') < prompt.indexOf('Custom instructions'))
  })

  it('names no model in the steering text — it reads as house rules', () => {
    for (const block of [OPUS_5_RESPONSE_LENGTH_BLOCK, OPUS_5_TONE_REMINDER]) {
      assert.doesNotMatch(block, /Claude|Opus|GPT|Gemini/i)
    }
  })
})

describe('buildSystemPrompt working directory', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setSetting('skillsEnabled', false)
    setSetting('skillPluginPaths', [])
    setSetting('customInstructions', '')
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-system-prompt-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  const build = (model?: string): Promise<string> =>
    buildSystemPrompt({
      subagentsEnabled: false,
      invokedSkills: [],
      ...(model === undefined ? {} : { model }),
    })

  it('names the renderer workspace root when no thread context is active', async () => {
    const prompt = await build()
    assert.ok(
      prompt.includes(`Working directory: ${tempRoot}`),
      'fallback path should use the renderer-selected workspace root',
    )
  })

  it('names the thread execution root when a worktree context is active', async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'copse-worktree-prompt-'))
    const context: ThreadExecutionContext = Object.freeze({
      projectId: 'test-project',
      threadId: 'test-thread',
      projectRoot: tempRoot,
      root: worktreeRoot,
      checkoutMode: 'worktree',
      branch: 'copse/test',
    })
    try {
      const prompt = await runWithThreadExecutionContext(context, () => build())
      assert.ok(
        prompt.includes(`Working directory: ${worktreeRoot}`),
        'thread path should use the worktree execution root, not the main workspace root',
      )
      assert.ok(
        !prompt.includes(`Working directory: ${tempRoot}`),
        'thread path must not leak the renderer workspace root into the prompt',
      )
    } finally {
      await rm(worktreeRoot, { recursive: true, force: true })
    }
  })
})
