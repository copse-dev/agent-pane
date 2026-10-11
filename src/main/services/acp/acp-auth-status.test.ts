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

  it('finds Codex and Gemini logins by their credential files', async () => {
    const files = new Set(['/home/u/.codex/auth.json'])
    const d = deps({ fileExists: (p) => Promise.resolve(files.has(p)) })
    assert.equal(await probeAcpAuth('codex-acp', d), 'signed-in')
    assert.equal(await probeAcpAuth('gemini', d), 'signed-out')
    files.add('/home/u/.gemini/oauth_creds.json')
    assert.equal(await probeAcpAuth('gemini', d), 'signed-in')
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
