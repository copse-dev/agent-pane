import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage } from '@shared/types'
import {
  REDACTED_PLACEHOLDER,
  redactSecretsFromText,
  redactMessages,
} from './redact-secrets.ts'

describe('redactSecretsFromText', () => {
  it('redacts a classic GitHub personal access token', () => {
    const token = `ghp_${'a'.repeat(40)}`
    const out = redactSecretsFromText(`my token is ${token} ok`)
    assert.ok(!out.includes(token))
    assert.equal(out, `my token is ${REDACTED_PLACEHOLDER} ok`)
  })

  it('redacts fine-grained GitHub PATs and other gh_ prefixes', () => {
    const fine = `github_pat_${'A'.repeat(30)}`
    const oauth = `gho_${'b'.repeat(40)}`
    const out = redactSecretsFromText(`${fine} and ${oauth}`)
    assert.ok(!out.includes(fine))
    assert.ok(!out.includes(oauth))
  })

  it('redacts Anthropic, OpenAI and OpenRouter keys', () => {
    const ant = `sk-ant-${'x'.repeat(30)}`
    const oai = `sk-proj-${'y'.repeat(40)}`
    const or = `sk-or-v1-${'c'.repeat(40)}`
    const out = redactSecretsFromText([ant, oai, or].join(' '))
    assert.ok(!out.includes(ant))
    assert.ok(!out.includes(oai))
    assert.ok(!out.includes(or))
  })

  it('redacts AWS, Google, Slack, Stripe, GitLab and HF tokens', () => {
    const samples = [
      `AKIA${'A'.repeat(16)}`,
      `AIza${'a'.repeat(35)}`,
      `xoxb-${'1'.repeat(20)}`,
      `sk_live_${'a'.repeat(24)}`,
      `glpat-${'a'.repeat(20)}`,
      `hf_${'a'.repeat(34)}`,
    ]
    for (const s of samples) {
      const out = redactSecretsFromText(`value=${s}`)
      assert.ok(!out.includes(s), `expected ${s} to be redacted, got: ${out}`)
    }
  })

  it('leaves ordinary prose untouched', () => {
    const text = 'The quick brown fox jumps over the lazy dog.'
    assert.equal(redactSecretsFromText(text), text)
  })

  it('redacts caller-supplied literal secrets (e.g. configured API keys)', () => {
    const secret = 'super-secret-deploy-key-1234'
    const out = redactSecretsFromText(`token=${secret}`, [secret])
    assert.equal(out, `token=${REDACTED_PLACEHOLDER}`)
  })

  it('ignores trivially short literal secrets', () => {
    const out = redactSecretsFromText('the value is abc', ['abc'])
    assert.equal(out, 'the value is abc')
  })

  it('returns the input unchanged when there is nothing to redact', () => {
    const text = 'nothing secret here'
    assert.equal(redactSecretsFromText(text), text)
  })
})

describe('redactMessages', () => {
  const token = `ghp_${'z'.repeat(40)}`

  it('redacts secrets across system, user, assistant and tool messages', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: `system has ${token}` },
      { role: 'user', content: `user typed ${token}` },
      {
        role: 'user',
        content: [{ type: 'text', text: `block ${token}` }, { type: 'image', dataUrl: 'data:image/png;base64,AAA' }],
      },
      { role: 'assistant', content: `assistant said ${token}` },
      { role: 'tool', toolResults: [{ toolCallId: '1', result: `cat .env => ${token}` }] },
    ]
    const out = redactMessages(messages)
    const serialized = JSON.stringify(out)
    assert.ok(!serialized.includes(token), 'no message should still contain the token')
    // Non-text image part is preserved structurally.
    const userArray = out[2]
    assert.ok(userArray && userArray.role === 'user' && Array.isArray(userArray.content))
    assert.equal(userArray.content[1]?.type, 'image')
  })

  it('returns the original objects unchanged when there are no secrets', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'plain' },
      { role: 'user', content: 'hello' },
    ]
    const out = redactMessages(messages)
    assert.equal(out[0], messages[0])
    assert.equal(out[1], messages[1])
  })

  it('does not mutate tool-call argument objects on assistant messages', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: [{ id: '1', name: 'run', args: { cmd: `echo ${token}` } }] },
    ]
    const out = redactMessages(messages)
    // Args are model-authored structure, left intact by design.
    assert.deepEqual(out[0], messages[0])
  })
})
