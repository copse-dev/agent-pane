import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage } from './wire-types.ts'
import { redactSecrets, redactMessages } from './redact-secrets.ts'

describe('redactSecrets — secret patterns (#518)', () => {
  it('redacts classic GitHub personal access tokens (ghp_)', () => {
    const token = 'ghp_' + 'A'.repeat(36)
    const out = redactSecrets(`token is ${token} ok`)
    assert.equal(out, 'token is [REDACTED_GITHUB_TOKEN] ok')
    assert.ok(!out.includes(token))
  })

  it('redacts every classic GitHub token prefix (gho/ghu/ghs/ghr)', () => {
    for (const prefix of ['gho', 'ghu', 'ghs', 'ghr']) {
      const token = `${prefix}_` + 'b'.repeat(36)
      assert.equal(redactSecrets(token), '[REDACTED_GITHUB_TOKEN]', prefix)
    }
  })

  it('redacts fine-grained GitHub PATs (github_pat_)', () => {
    const token = 'github_pat_' + 'A'.repeat(22) + '_' + 'B'.repeat(59)
    const out = redactSecrets(`export GH=${token}`)
    assert.equal(out, 'export GH=[REDACTED_GITHUB_TOKEN]')
    assert.ok(!out.includes(token))
  })

  it('redacts OpenAI keys including project/service variants', () => {
    const keys = [
      'sk-' + 'a'.repeat(40),
      'sk-proj-' + 'b'.repeat(40),
      'sk-svcacct-' + 'c'.repeat(40),
    ]
    for (const key of keys) {
      assert.equal(redactSecrets(`KEY=${key}`), 'KEY=[REDACTED_OPENAI_API_KEY]', key)
    }
  })

  it('redacts Anthropic keys (sk-ant-) without colliding with OpenAI label', () => {
    const key = 'sk-ant-api03-' + 'z'.repeat(40)
    const out = redactSecrets(`ANTHROPIC_API_KEY=${key}`)
    assert.equal(out, 'ANTHROPIC_API_KEY=[REDACTED_ANTHROPIC_API_KEY]')
  })

  it('redacts AWS access key ids (AKIA / ASIA)', () => {
    assert.equal(redactSecrets('AKIAIOSFODNN7EXAMPLE'), '[REDACTED_AWS_ACCESS_KEY_ID]')
    assert.equal(redactSecrets('ASIAY34FZKBOKMUTVV7A'), '[REDACTED_AWS_ACCESS_KEY_ID]')
  })

  it('redacts Google API keys (AIza...)', () => {
    const key = 'AIza' + 'D'.repeat(35)
    assert.equal(redactSecrets(key), '[REDACTED_GOOGLE_API_KEY]')
  })

  it('redacts Slack tokens (xoxb/xoxp)', () => {
    assert.equal(redactSecrets('xoxb-123456789012-abcdefghijklmnop'), '[REDACTED_SLACK_TOKEN]')
    assert.equal(redactSecrets('xoxp-123456789012-abcdefghijklmnop'), '[REDACTED_SLACK_TOKEN]')
  })

  it('redacts a PEM private key block including its multi-line body', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAabc123',
      'def456ghi789',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const out = redactSecrets(`here:\n${pem}\nend`)
    assert.equal(out, 'here:\n[REDACTED_PRIVATE_KEY]\nend')
    assert.ok(!out.includes('MIIEpA'))
  })

  it('redacts generic OPENSSH and EC private-key block variants', () => {
    for (const kind of ['OPENSSH', 'EC', '']) {
      const head = kind ? `${kind} ` : ''
      const pem = `-----BEGIN ${head}PRIVATE KEY-----\nbody\n-----END ${head}PRIVATE KEY-----`
      assert.equal(redactSecrets(pem), '[REDACTED_PRIVATE_KEY]', kind || 'generic')
    }
  })

  it('redacts the credential in an Authorization: Bearer header, keeping the prefix', () => {
    const out = redactSecrets('Authorization: Bearer abcDEF123456ghiJKL789')
    assert.equal(out, 'Authorization: Bearer [REDACTED_AUTHORIZATION_HEADER]')
  })

  it('redacts Authorization: Basic and token schemes case-insensitively', () => {
    assert.equal(
      redactSecrets('authorization:Basic dXNlcjpwYXNzd29yZDEyMw=='),
      'authorization:Basic [REDACTED_AUTHORIZATION_HEADER]',
    )
    assert.equal(
      redactSecrets('Authorization: token ' + 'q'.repeat(20)),
      'Authorization: token [REDACTED_AUTHORIZATION_HEADER]',
    )
  })

  it('redacts multiple distinct secrets in one blob', () => {
    const blob = `ghp_${'a'.repeat(36)} and sk-${'b'.repeat(40)}`
    assert.equal(redactSecrets(blob), '[REDACTED_GITHUB_TOKEN] and [REDACTED_OPENAI_API_KEY]')
  })

  it('is idempotent — re-running over redacted text is a no-op', () => {
    const once = redactSecrets(`ghp_${'a'.repeat(36)}`)
    assert.equal(redactSecrets(once), once)
  })

  it('redacts configured literal secrets that may not match regex patterns', () => {
    const literal = 'my-configured-key-123456'
    assert.equal(redactSecrets(`key=${literal}`, [literal]), 'key=[REDACTED_SECRET]')
  })
})

describe('redactSecrets — false-positive safety', () => {
  const proseSamples = [
    'The quick brown fox jumps over the lazy dog.',
    'Please review the pull request and merge when ready.',
    'He was the bearer of bad news about the authorization process.',
    'Run npm install then npm test to verify everything works.',
    'The function returns a Promise<string> that resolves to the result.',
    'My github username is octocat and my email is octo@example.com.',
    'See https://github.com/owner/repo/blob/main/src/index.ts for details.',
    'sk- is just a shorthand someone used in a sentence.',
    'AKIA is mentioned but not followed by a key.',
  ]
  for (const sample of proseSamples) {
    it(`leaves ordinary prose unchanged: "${sample.slice(0, 32)}..."`, () => {
      assert.equal(redactSecrets(sample), sample)
    })
  }

  it('returns empty string unchanged', () => {
    assert.equal(redactSecrets(''), '')
  })

  it('does not redact a short sk- string that is not a key', () => {
    assert.equal(redactSecrets('sk-12'), 'sk-12')
  })
})

describe('redactMessages — wiring across message shapes (#518)', () => {
  it('scrubs user string content', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: `my token ghp_${'a'.repeat(36)}` }]
    const [m] = redactMessages(messages)
    assert.deepEqual(m, { role: 'user', content: 'my token [REDACTED_GITHUB_TOKEN]' })
  })

  it('scrubs text parts of multimodal user content but leaves images', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `key sk-${'b'.repeat(40)}` },
          { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
        ],
      },
    ]
    const [m] = redactMessages(messages)
    assert.deepEqual(m, {
      role: 'user',
      content: [
        { type: 'text', text: 'key [REDACTED_OPENAI_API_KEY]' },
        { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
      ],
    })
  })

  it('scrubs assistant text and tool-call argument strings', () => {
    const messages: LLMMessage[] = [
      { role: 'assistant', content: `done ghp_${'c'.repeat(36)}` },
      {
        role: 'assistant',
        content: [{ id: 't1', name: 'shell', args: { cmd: `echo ghp_${'d'.repeat(36)}` } }],
      },
    ]
    const out = redactMessages(messages)
    assert.deepEqual(out[0], { role: 'assistant', content: 'done [REDACTED_GITHUB_TOKEN]' })
    assert.deepEqual(out[1], {
      role: 'assistant',
      content: [{ id: 't1', name: 'shell', args: { cmd: 'echo [REDACTED_GITHUB_TOKEN]' } }],
    })
  })

  it('scrubs tool results — the most common secret carrier', () => {
    const messages: LLMMessage[] = [
      {
        role: 'tool',
        toolResults: [{ toolCallId: 't1', result: `GITHUB_TOKEN=ghp_${'e'.repeat(36)}` }],
      },
    ]
    const [m] = redactMessages(messages)
    assert.deepEqual(m, {
      role: 'tool',
      toolResults: [{ toolCallId: 't1', result: 'GITHUB_TOKEN=[REDACTED_GITHUB_TOKEN]' }],
    })
  })

  it('leaves the app-authored system prompt untouched', () => {
    const messages: LLMMessage[] = [{ role: 'system', content: `system ghp_${'f'.repeat(36)}` }]
    const [m] = redactMessages(messages)
    assert.deepEqual(m, messages[0])
  })

  it('does not mutate the input messages', () => {
    const original: LLMMessage[] = [{ role: 'user', content: `ghp_${'g'.repeat(36)}` }]
    const snapshot = JSON.stringify(original)
    redactMessages(original)
    assert.equal(JSON.stringify(original), snapshot)
  })
})
