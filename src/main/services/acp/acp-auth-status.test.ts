import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { probeAcpAuth, type AcpAuthProbeDeps } from './acp-auth-status.ts'

function deps(over: Partial<AcpAuthProbeDeps> = {}): AcpAuthProbeDeps {
  return {
    env: {},
    home: '/home/u',
    fileExists: () => Promise.resolve(false),
    exec: () => Promise.reject(new Error('not run')),
    ...over,
  }
}

describe('probeAcpAuth', () => {
  it('reads Claude from `claude auth status`', async () => {
    const run = (stdout: string): AcpAuthProbeDeps => deps({ exec: () => Promise.resolve(stdout) })
    assert.equal(await probeAcpAuth('claude-acp', run('{"loggedIn":true}')), 'signed-in')
    assert.equal(await probeAcpAuth('claude-acp', run('{"loggedIn":false}')), 'signed-out')
    assert.equal(await probeAcpAuth('claude-acp', run('{"other":1}')), 'unknown')
    assert.equal(await probeAcpAuth('claude-acp', run('not json')), 'unknown')
  })

  it('treats a Claude CLI that cannot answer as unknown, never signed out', async () => {
    assert.equal(await probeAcpAuth('claude-acp', deps()), 'unknown')
  })

  it('counts an API key in the agent environment as signed in', async () => {
    assert.equal(
      await probeAcpAuth('claude-acp', deps({ env: { ANTHROPIC_API_KEY: 'sk-ant-x' } })),
      'signed-in',
    )
    assert.equal(await probeAcpAuth('gemini', deps({ env: { GEMINI_API_KEY: ' ' } })), 'signed-out')
  })

  it('does not claim authentication from credential-file presence alone', async () => {
    const files = new Set(['/home/u/.codex/auth.json'])
    const d = deps({ fileExists: (p) => Promise.resolve(files.has(p)) })
    assert.equal(await probeAcpAuth('codex-acp', d), 'unknown')
    assert.equal(await probeAcpAuth('gemini', d), 'signed-out')
    files.add('/home/u/.gemini/oauth_creds.json')
    assert.equal(await probeAcpAuth('gemini', d), 'unknown')
  })

  it('reads Codex login status without treating a credential file as proof', async () => {
    assert.equal(
      await probeAcpAuth('codex-acp', deps({ exec: async () => 'Logged in using ChatGPT' })),
      'signed-in',
    )
    assert.equal(
      await probeAcpAuth('codex-acp', deps({ exec: async () => 'Not logged in' })),
      'signed-out',
    )
    assert.equal(
      await probeAcpAuth('codex-acp', deps({ exec: async () => 'Unknown command' })),
      'unknown',
    )
  })

  it('parses `cursor-agent status`', async () => {
    const run = (stdout: string): AcpAuthProbeDeps => deps({ exec: () => Promise.resolve(stdout) })
    assert.equal(await probeAcpAuth('cursor', run('✓ Logged in as a@b.c')), 'signed-in')
    assert.equal(await probeAcpAuth('cursor', run('Not logged in')), 'signed-out')
    assert.equal(await probeAcpAuth('cursor', deps()), 'unknown')
  })

  it('is unknown for an agent it has no check for, including prototype keys', async () => {
    assert.equal(await probeAcpAuth('goose', deps()), 'unknown')
    assert.equal(await probeAcpAuth('constructor', deps()), 'unknown')
  })
})

describe('detectAcpAuthStatus environment boundary', () => {
  it('does not use ambient provider keys that the ACP child cannot receive', async () => {
    const { detectAcpAuthStatus } = await import('./acp-auth-status.ts')
    const previous = process.env['OPENAI_API_KEY']
    process.env['OPENAI_API_KEY'] = 'ambient-test-key'
    try {
      const result = await detectAcpAuthStatus(['codex-acp'], (env) => {
        assert.equal(env['OPENAI_API_KEY'], undefined)
        return deps({ env })
      })
      assert.deepEqual(result, [{ id: 'codex-acp', state: 'signed-out' }])
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')
      else process.env['OPENAI_API_KEY'] = previous
    }
  })

  it('uses the configured Codex home and treats unrecognised CLI output as unknown', async () => {
    let inspected = ''
    await probeAcpAuth(
      'codex-acp',
      deps({
        env: { CODEX_HOME: '/custom/codex' },
        fileExists: async (path) => {
          inspected = path
          return false
        },
      }),
    )
    assert.equal(inspected, '/custom/codex/auth.json')
    assert.equal(
      await probeAcpAuth('cursor', deps({ exec: async () => 'Unexpected help text' })),
      'unknown',
    )
  })
})
