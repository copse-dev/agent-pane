/**
 * The one `childHookEnv` behaviour that is the app's, not the package's: the
 * environment handed to an unsandboxed hook process is the secret-scrubbed env
 * (`envForRendererChildProcess`), so LLM provider keys never reach a hook. The
 * package default passes the env through; this exercises the binding in
 * `hooks-dialects-environment.ts`. The recursion-guard semantics themselves are
 * tested with the package.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import './hooks-dialects-environment.ts'
import { childHookEnv } from '@copse/hooks-dialects/hook-depth.ts'

describe('hook child env (app binding)', () => {
  it('childHookEnv preserves the secret-scrubbed env and drops LLM keys', () => {
    const env = childHookEnv({
      PATH: '/bin',
      GITHUB_TOKEN: 'gh-keep',
      ANTHROPIC_API_KEY: 'sk-secret',
    })
    assert.equal(env['PATH'], '/bin')
    assert.equal(env['GITHUB_TOKEN'], 'gh-keep', 'non-LLM tool tokens still reach hooks')
    assert.equal('ANTHROPIC_API_KEY' in env, false, 'LLM provider keys are scrubbed')
  })
})
