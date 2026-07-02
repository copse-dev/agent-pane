import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import {
  AcpTurnFailure,
  buildAcpPrompt,
  formatPermissionBody,
  isRetryableAcpError,
  permissionKindLabel,
  permissionResponseFor,
  runWithAcpRetry,
  sliceLines,
} from './acp-agent-service.ts'

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

  it('prefers allow_always for remembered grants so the agent stops asking too', () => {
    const res = permissionResponseFor([ALLOW_ONCE, ALLOW_ALWAYS], true, { preferAlways: true })
    assert.deepEqual(res.outcome, { outcome: 'selected', optionId: 'a2' })
  })

  it('falls back to allow_once when a remembered grant has no allow_always option', () => {
    const res = permissionResponseFor([ALLOW_ONCE, REJECT_ONCE], true, { preferAlways: true })
    assert.deepEqual(res.outcome, { outcome: 'selected', optionId: 'a1' })
  })
})

function permissionRequest(
  toolCall: Partial<RequestPermissionRequest['toolCall']>,
): RequestPermissionRequest {
  return {
    sessionId: 's1',
    toolCall: { toolCallId: 't1', ...toolCall },
    options: [],
  }
}

describe('formatPermissionBody', () => {
  it('falls back to the unwrapped title when there is no input', () => {
    assert.equal(formatPermissionBody(permissionRequest({ title: '`git status`' })), 'git status')
    assert.equal(formatPermissionBody(permissionRequest({})), 'Run this tool call?')
  })

  it('renders scalar rawInput fields as labelled lines, with the command bare', () => {
    const body = formatPermissionBody(
      permissionRequest({
        title: 'Run command',
        rawInput: { command: 'rm -rf dist', description: 'Clean build output', timeout: 5000 },
      }),
    )
    assert.equal(body, 'rm -rf dist\ndescription: Clean build output\ntimeout: 5000')
  })

  it('drops lines that would only repeat the dialog title', () => {
    const body = formatPermissionBody(
      permissionRequest({ title: '`npm test`', rawInput: { command: 'npm test' } }),
    )
    assert.equal(body, 'npm test')
    const empty = formatPermissionBody(
      permissionRequest({ title: '`npm test`', rawInput: { description: 'npm test' } }),
    )
    assert.equal(empty, 'npm test') // nothing left → fallback title
  })

  it('keeps nested values as pretty JSON after the scalar lines', () => {
    const body = formatPermissionBody(
      permissionRequest({
        title: 'Edit file',
        rawInput: { path: 'src/a.ts', edits: [{ old: 'a', new: 'b' }] },
      }),
    )
    assert.equal(
      body,
      'path: src/a.ts\n' + JSON.stringify({ edits: [{ old: 'a', new: 'b' }] }, null, 2),
    )
  })

  it('unwraps inline code from string input and skips null-ish fields', () => {
    assert.equal(
      formatPermissionBody(permissionRequest({ title: 't', rawInput: '`ls -la`' })),
      'ls -la',
    )
    assert.equal(
      formatPermissionBody(
        permissionRequest({ title: '`fetch`', rawInput: { url: null, method: undefined } }),
      ),
      'fetch',
    )
  })
})

describe('permissionKindLabel', () => {
  it('names known ACP tool kinds in plain language', () => {
    assert.equal(permissionKindLabel('execute'), 'terminal commands')
    assert.equal(permissionKindLabel('read'), 'file reads')
    assert.equal(permissionKindLabel('edit'), 'file edits')
    assert.equal(permissionKindLabel('fetch'), 'web fetches')
  })

  it('quotes unknown kinds instead of guessing', () => {
    assert.equal(permissionKindLabel('think'), '"think" tool calls')
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

describe('isRetryableAcpError', () => {
  it('matches transient provider failures surfaced as opaque agent text', () => {
    assert.ok(isRetryableAcpError(new Error('Internal error: API Error: Overloaded')))
    assert.ok(isRetryableAcpError(new Error('429 rate_limit_error')))
    assert.ok(isRetryableAcpError(new Error('upstream returned 503')))
    assert.ok(isRetryableAcpError(new Error('Internal Server Error')))
  })

  it('rejects non-transient failures', () => {
    assert.ok(!isRetryableAcpError(new Error('401 Unauthorized')))
    assert.ok(!isRetryableAcpError(new Error('ACP agent "x" is not configured or is disabled.')))
    assert.ok(!isRetryableAcpError(new Error('Write to src/a.ts was rejected by the user.')))
  })
})

describe('runWithAcpRetry', () => {
  const noAbort = new AbortController().signal
  const overloaded = (): Error => new Error('Internal error: API Error: Overloaded')

  it('retries a no-progress transient failure and succeeds', async () => {
    let attempts = 0
    const result = await runWithAcpRetry(
      () => {
        attempts++
        return attempts < 3 ? Promise.reject(overloaded()) : Promise.resolve('ok')
      },
      { signal: noAbort, hasProgress: () => false, delayMs: () => 0 },
    )
    assert.equal(result, 'ok')
    assert.equal(attempts, 3)
  })

  it('does not retry once the turn has made visible progress', async () => {
    let attempts = 0
    await assert.rejects(
      runWithAcpRetry(
        () => {
          attempts++
          return Promise.reject(overloaded())
        },
        { signal: noAbort, hasProgress: () => true, delayMs: () => 0 },
      ),
      /Overloaded/,
    )
    assert.equal(attempts, 1)
  })

  it('does not retry non-transient failures', async () => {
    let attempts = 0
    await assert.rejects(
      runWithAcpRetry(
        () => {
          attempts++
          return Promise.reject(new Error('401 Unauthorized'))
        },
        { signal: noAbort, hasProgress: () => false, delayMs: () => 0 },
      ),
      /401/,
    )
    assert.equal(attempts, 1)
  })

  it('gives up after maxAttempts', async () => {
    let attempts = 0
    await assert.rejects(
      runWithAcpRetry(
        () => {
          attempts++
          return Promise.reject(overloaded())
        },
        { signal: noAbort, hasProgress: () => false, maxAttempts: 2, delayMs: () => 0 },
      ),
      /Overloaded/,
    )
    assert.equal(attempts, 2)
  })

  it('does not retry after the turn is aborted', async () => {
    const controller = new AbortController()
    let attempts = 0
    await assert.rejects(
      runWithAcpRetry(
        () => {
          attempts++
          controller.abort()
          return Promise.reject(overloaded())
        },
        { signal: controller.signal, hasProgress: () => false, delayMs: () => 0 },
      ),
      /Overloaded/,
    )
    assert.equal(attempts, 1)
  })
})

describe('AcpTurnFailure', () => {
  it('keeps the underlying message so classifyAgentError still matches it', () => {
    const failure = new AcpTurnFailure(new Error('Internal error: API Error: Overloaded'), {
      assistantText: 'partial answer',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    assert.equal(failure.message, 'Internal error: API Error: Overloaded')
    assert.equal(failure.partial.assistantText, 'partial answer')
    assert.deepEqual(failure.partial.usage, { inputTokens: 10, outputTokens: 5 })
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
