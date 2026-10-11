import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BRIDGE_TOOL_NAMES } from '../acp/acp-native-bridge.ts'
import { GUEST_ALLOWED_TOOLS } from './guest-tools.ts'

describe('GUEST_ALLOWED_TOOLS', () => {
  it('excludes every GitHub and CI tool the ACP bridge could offer', () => {
    const githubShaped = BRIDGE_TOOL_NAMES.filter(
      (name) => name.startsWith('gh_') || /_ci_|^get_ci|^wait_for_ci/.test(name),
    )
    assert.ok(githubShaped.length >= 12)
    for (const name of githubShaped) assert.ok(!GUEST_ALLOWED_TOOLS.includes(name), name)
  })

  it('excludes unsupported desktop services, interactive tools and extra model routes', () => {
    for (const name of [
      'launch_gui_app',
      'read_terminal',
      'open_simulator_desktop',
      'device_hub',
      'ask_user',
      'propose_thread',
      'run_checkup',
      'explore',
      'delegate_step',
      'advisor',
      'review_changes',
      'semantic_search',
      'search_codebase',
      'web_search',
      'fetch_url',
      'video_frames',
      'image_gen',
      'read_skill',
      'preflight_worktree',
      'prepare_worktree',
      'run_background',
    ])
      assert.ok(!GUEST_ALLOWED_TOOLS.includes(name), name)
  })

  it('retains local coding tools with no duplicate entries', () => {
    assert.equal(new Set(GUEST_ALLOWED_TOOLS).size, GUEST_ALLOWED_TOOLS.length)
    for (const name of [
      'read_file',
      'write_file',
      'apply_patch',
      'search_code',
      'find_files',
      'git_status',
      'git_commit',
      'run_shell',
      'update_todos',
      'read_archive',
    ]) {
      assert.ok(GUEST_ALLOWED_TOOLS.includes(name), name)
    }
  })
})
