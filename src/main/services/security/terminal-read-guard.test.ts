import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import {
  TERMINAL_READ_SCREEN_MAX_CHARS,
  ensureTerminalReadPermitted,
  setTerminalSnapshotClassifierForTest,
  type TerminalReadVerdict,
} from './terminal-read-guard.ts'

/**
 * The safety model is shown only the trailing slice of a snapshot, so its
 * verdict can only vouch for that slice. These tests pin the gate's side of
 * that contract: a confident "safe" never auto-shares a snapshot larger than
 * the screened window (#2280), and the explanation the user sees says how much
 * the model actually looked at.
 */

const CONFIDENT_SAFE: TerminalReadVerdict = {
  risky: false,
  confidence: 0.95,
  reason: 'ordinary build output',
}

/** `count` numbered lines of roughly `width` characters each. */
function scrollback(count: number, width = 80): string {
  const lines: string[] = []
  for (let i = 1; i <= count; i++) {
    lines.push(`[${String(i).padStart(5, '0')}] ${'build output '.repeat(width)}`.slice(0, width))
  }
  return lines.join('\n')
}

let classifierCalls: string[] = []
let prompts: ApprovalRequest[] = []
let promptAnswer: { approved: boolean; remember: boolean } = { approved: true, remember: false }

beforeEach(() => {
  classifierCalls = []
  prompts = []
  promptAnswer = { approved: true, remember: false }
  setTerminalSnapshotClassifierForTest((text) => {
    classifierCalls.push(text)
    return Promise.resolve(CONFIDENT_SAFE)
  })
  setApprovalHandler((req) => {
    prompts.push(req)
    return Promise.resolve(promptAnswer)
  })
})

afterEach(() => {
  setTerminalSnapshotClassifierForTest(null)
  setApprovalHandler(null)
})

describe('read_terminal gate: a snapshot that fits the screened window', () => {
  it('auto-shares on a confident safe verdict, having screened the whole snapshot', async () => {
    const text = scrollback(40)
    assert.ok(text.length <= TERMINAL_READ_SCREEN_MAX_CHARS)

    const result = await ensureTerminalReadPermitted(null, 'Build', text)

    assert.deepEqual(result, { allowed: true })
    assert.deepEqual(classifierCalls, [text])
    assert.equal(prompts.length, 0)
  })

  it('still asks the user when the verdict is risky, naming the reason', async () => {
    setTerminalSnapshotClassifierForTest(() =>
      Promise.resolve({ risky: true, confidence: 0.8, reason: 'looks like an API token' }),
    )
    promptAnswer = { approved: false, remember: false }

    const result = await ensureTerminalReadPermitted(null, 'Build', scrollback(40))

    assert.equal(result.allowed, false)
    assert.match(result.deniedMessage ?? '', /declined to share/)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0]?.body ?? '', /flagged it: looks like an API token/)
  })
})

describe('read_terminal gate: a snapshot larger than the screened window', () => {
  it('never auto-shares on a safe verdict — the model did not see all of it', async () => {
    const text = scrollback(200)
    assert.ok(text.length > TERMINAL_READ_SCREEN_MAX_CHARS)
    promptAnswer = { approved: false, remember: false }

    const result = await ensureTerminalReadPermitted(null, 'Build', text)

    assert.equal(result.allowed, false)
    assert.match(result.deniedMessage ?? '', /declined to share/)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0]?.cause, 'terminal-output-share')
  })

  it('goes to the user without spending a screening call that could not change the outcome', async () => {
    await ensureTerminalReadPermitted(null, 'Build', scrollback(200))

    assert.equal(classifierCalls.length, 0)
    assert.equal(prompts.length, 1)
  })

  it('tells the user how much of the snapshot was actually screened', async () => {
    // 200 lines of 80 chars + newline: the window holds 74 whole lines plus
    // the tail of a 75th, which the model partly sees and so counts as screened.
    await ensureTerminalReadPermitted(null, 'Build', scrollback(200))

    const body = prompts[0]?.body ?? ''
    assert.match(body, /"Build" shell/)
    assert.match(body, /larger than the safety model screens/)
    assert.match(body, /only the most recent 75 of its 200 lines were screened/)
  })

  it('shares it once the user approves', async () => {
    const result = await ensureTerminalReadPermitted(null, 'Build', scrollback(200))

    assert.deepEqual(result, { allowed: true })
    assert.equal(prompts.length, 1)
  })

  it('honours "Always allow for this chat" for later reads in that chat only', async () => {
    promptAnswer = { approved: true, remember: true }
    await ensureTerminalReadPermitted('thread-remembered', 'Build', scrollback(200))
    assert.equal(prompts.length, 1)

    await ensureTerminalReadPermitted('thread-remembered', 'Build', scrollback(300))
    assert.equal(prompts.length, 1)

    await ensureTerminalReadPermitted('thread-other', 'Build', scrollback(300))
    assert.equal(prompts.length, 2)
  })

  it('explains an oversized snapshot with no line breaks without a bogus line count', async () => {
    const text = 'x'.repeat(TERMINAL_READ_SCREEN_MAX_CHARS + 1)

    await ensureTerminalReadPermitted(null, 'Build', text)

    const body = prompts[0]?.body ?? ''
    assert.match(body, /part of it was not screened/)
    assert.doesNotMatch(body, /of its/)
  })
})
