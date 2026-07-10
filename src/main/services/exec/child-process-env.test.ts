import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { envForRendererChildProcess } from './child-process-env.ts'

describe('envForRendererChildProcess', () => {
  it('strips LLM API keys from the child environment', () => {
    const env = envForRendererChildProcess({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-openai-secret',
      HOME: '/Users/me',
    })
    assert.equal(env['PATH'], '/usr/bin')
    assert.equal(env['HOME'], '/Users/me')
    assert.equal(env['ANTHROPIC_API_KEY'], undefined)
    assert.equal(env['OPENAI_API_KEY'], undefined)
  })

  it('strips other LLM provider keys by name and pattern', () => {
    const env = envForRendererChildProcess({
      PATH: '/usr/bin',
      GEMINI_API_KEY: 'g',
      GROQ_API_KEY: 'q',
      MISTRAL_API_KEY: 'm',
      OPENROUTER_API_KEY: 'o',
      ANTHROPIC_AUTH_TOKEN: 'a', // caught by the provider pattern, not the list
    })
    assert.equal(env['PATH'], '/usr/bin')
    assert.equal(env['GEMINI_API_KEY'], undefined)
    assert.equal(env['GROQ_API_KEY'], undefined)
    assert.equal(env['MISTRAL_API_KEY'], undefined)
    assert.equal(env['OPENROUTER_API_KEY'], undefined)
    assert.equal(env['ANTHROPIC_AUTH_TOKEN'], undefined)
  })

  it('keeps non-LLM tool tokens that subprocesses legitimately need', () => {
    const env = envForRendererChildProcess({
      GITHUB_TOKEN: 'gh',
      NPM_TOKEN: 'npm',
      AWS_ACCESS_KEY_ID: 'aws',
    })
    assert.equal(env['GITHUB_TOKEN'], 'gh')
    assert.equal(env['NPM_TOKEN'], 'npm')
    assert.equal(env['AWS_ACCESS_KEY_ID'], 'aws')
  })

  // Regression for #579: the strip must be applied to the *base* env, never as an
  // overlay. A stripped env spread on top of a full one does NOT remove a secret key —
  // the base value survives. This is exactly how the sandboxed/PTY spawn paths in
  // project-sandbox/spawn.ts leaked despite their callers passing a scrubbed env.
  it('as an overlay it does NOT remove a secret already in the base (the bug)', () => {
    const full = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-secret' }
    const stripped = envForRendererChildProcess({ PATH: '/usr/bin' })
    // The wrong pattern: full env as base, stripped env overlaid on top.
    const merged: Record<string, string> = { ...full, ...stripped }
    assert.equal(merged['ANTHROPIC_API_KEY'], 'sk-ant-secret')
  })

  it('as the base the secret is gone even when an explicit opt-in env is overlaid', () => {
    const full = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-secret' }
    // The correct pattern: scrub the base first, then overlay opts.env.
    const merged: Record<string, string> = {
      ...envForRendererChildProcess(full),
      GIT_AUTHOR_NAME: 'Copse',
    }
    assert.equal(merged['ANTHROPIC_API_KEY'], undefined)
    assert.equal(merged['PATH'], '/usr/bin')
    assert.equal(merged['GIT_AUTHOR_NAME'], 'Copse')
  })
})
