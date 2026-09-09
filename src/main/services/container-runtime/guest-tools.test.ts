import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_TOOL_NAMES } from '../acp/acp-native-bridge.ts'
import { GUEST_EXCLUDED_TOOLS } from './guest-tools.ts'

describe('GUEST_EXCLUDED_TOOLS', () => {
  it('names every GitHub write tool', () => {
    for (const name of [
      'gh_pr_create',
      'gh_pr_approve',
      'gh_pr_mark_ready',
      'gh_pr_enable_auto_merge',
    ]) {
      assert.ok(GUEST_EXCLUDED_TOOLS.includes(name), name)
    }
  })

  it('covers every GitHub and CI tool the ACP bridge could offer', () => {
    // The bridge list is the ceiling of what an agent in the guest can be
    // handed; anything GitHub-shaped in it must be on the exclusion list, so a
    // new gh_* tool added to the bridge fails here until it is excluded too.
    const githubShaped = BRIDGE_TOOL_NAMES.filter(
      (name) => name.startsWith('gh_') || /_ci_|^get_ci|^wait_for_ci/.test(name),
    )
    assert.ok(githubShaped.length >= 12)
    for (const name of githubShaped) assert.ok(GUEST_EXCLUDED_TOOLS.includes(name), name)
  })
})
