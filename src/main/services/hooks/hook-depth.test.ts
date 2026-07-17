import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOOK_DEPTH_ENV,
  MAX_HOOK_DEPTH,
  childHookEnv,
  currentHookDepth,
  hookRecursionGuardTripped,
} from './hook-depth.ts'

// COPSE_HOOK_DEPTH recursion guard (decision 5). See
// docs/plans/hooks-and-feature-packs.md (C3 row).

describe('hook recursion guard (COPSE_HOOK_DEPTH)', () => {
  it('a top-level process (env unset) has depth 0 and fires hooks', () => {
    const env: NodeJS.ProcessEnv = {}
    assert.equal(currentHookDepth(env), 0)
    assert.equal(hookRecursionGuardTripped(env), false)
  })

  it('a process inside a hook (depth ≥ MAX) suppresses its own hooks', () => {
    const env: NodeJS.ProcessEnv = { [HOOK_DEPTH_ENV]: String(MAX_HOOK_DEPTH) }
    assert.equal(currentHookDepth(env), MAX_HOOK_DEPTH)
    assert.equal(hookRecursionGuardTripped(env), true)
  })

  it('a garbage / non-positive depth reads as 0 (fail toward firing at the top level)', () => {
    assert.equal(currentHookDepth({ [HOOK_DEPTH_ENV]: 'nope' }), 0)
    assert.equal(currentHookDepth({ [HOOK_DEPTH_ENV]: '-3' }), 0)
    assert.equal(currentHookDepth({ [HOOK_DEPTH_ENV]: '0' }), 0)
  })

  it('childHookEnv bumps the depth one level for the spawned hook process', () => {
    const top = childHookEnv({ PATH: '/bin' })
    assert.equal(top[HOOK_DEPTH_ENV], '1', 'a hook spawned from the top level runs at depth 1')

    // A hook spawned from a process already at depth 1 runs at depth 2 — the
    // grandchild is also guarded even if the child somehow re-spawned.
    const nested = childHookEnv({ [HOOK_DEPTH_ENV]: '1' })
    assert.equal(nested[HOOK_DEPTH_ENV], '2')
  })

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
