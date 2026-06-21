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
    assert.equal(env.PATH, '/usr/bin')
    assert.equal(env.HOME, '/Users/me')
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.OPENAI_API_KEY, undefined)
  })
})
