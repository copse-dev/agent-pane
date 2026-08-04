import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSystemPrompt } from './agent-system-prompt.ts'
import { OPUS_5_RESPONSE_LENGTH_BLOCK, OPUS_5_TONE_REMINDER } from './agent-prompt.ts'
import { setSetting } from './storage/settings.test-shim.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

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

  it('matches dated Opus 5 snapshots and suffixed routing ids', async () => {
    const prompt = await build('claude-opus-5-20260101')
    assert.ok(prompt.includes(CONCISENESS))
  })

  it('leaves every other model — and an unpinned model — untouched', async () => {
    for (const model of [
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'gpt-5.6-sol',
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
