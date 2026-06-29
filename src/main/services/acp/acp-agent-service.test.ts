import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PermissionOption } from '@agentclientprotocol/sdk'
import { buildAcpPrompt, permissionResponseFor, sliceLines } from './acp-agent-service.ts'

const ALLOW_ONCE: PermissionOption = { optionId: 'a1', name: 'Allow once', kind: 'allow_once' }
const ALLOW_ALWAYS: PermissionOption = {
  optionId: 'a2',
  name: 'Always allow',
  kind: 'allow_always',
}
const REJECT_ONCE: PermissionOption = { optionId: 'r1', name: 'Reject', kind: 'reject_once' }

describe('permissionResponseFor', () => {
  it('selects a one-shot allow option on approval, preferring allow_once', () => {
    const res = permissionResponseFor([ALLOW_ALWAYS, ALLOW_ONCE, REJECT_ONCE], true)
    assert.deepEqual(res.outcome, { outcome: 'selected', optionId: 'a1' })
  })

  it('falls back to allow_always when no one-shot allow is offered', () => {
    const res = permissionResponseFor([ALLOW_ALWAYS, REJECT_ONCE], true)
    assert.deepEqual(res.outcome, { outcome: 'selected', optionId: 'a2' })
  })

  it('selects a reject option on denial', () => {
    const res = permissionResponseFor([ALLOW_ONCE, REJECT_ONCE], false)
    assert.deepEqual(res.outcome, { outcome: 'selected', optionId: 'r1' })
  })

  it('cancels when the agent offered no option of the needed polarity', () => {
    assert.deepEqual(permissionResponseFor([REJECT_ONCE], true).outcome, { outcome: 'cancelled' })
    assert.deepEqual(permissionResponseFor([ALLOW_ONCE], false).outcome, { outcome: 'cancelled' })
  })
})

describe('sliceLines', () => {
  const file = 'one\ntwo\nthree\nfour\n'

  it('returns the whole file when no line/limit is given', () => {
    assert.equal(sliceLines(file), file)
  })

  it('slices from a 1-based start line', () => {
    assert.equal(sliceLines(file, 2), 'two\nthree\nfour\n')
  })

  it('applies a max line count from the start', () => {
    assert.equal(sliceLines(file, 2, 2), 'two\nthree')
    assert.equal(sliceLines(file, 1, 1), 'one')
  })
})

describe('buildAcpPrompt', () => {
  it('returns the bare prompt when there is no prior conversation', () => {
    assert.equal(buildAcpPrompt('hello', []), 'hello')
  })

  it('replays prior user/assistant turns as a preamble for a fresh session', () => {
    const prompt = buildAcpPrompt('and now?', [
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ])
    assert.match(prompt, /User: first question/)
    assert.match(prompt, /Assistant: first answer/)
    assert.match(prompt, /--- New message ---\nand now\?$/)
    assert.doesNotMatch(prompt, /ignored/) // system prompts are dropped
  })

  it('flattens array user content to its text blocks', () => {
    const prompt = buildAcpPrompt(
      [{ type: 'text', text: 'look at this' }],
      [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }],
    )
    assert.match(prompt, /User: earlier/)
    assert.match(prompt, /look at this$/)
  })
})
