import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BASE_SYSTEM_PROMPT,
  BASE_SYSTEM_PROMPT_DIRECT_READS,
  EXTERNAL_API_SAFETY_BLOCK,
  BROWSER_TOOLS_BLOCK,
} from './agent-prompt.ts'
import { BROWSER_TOOLS_DEFAULT_ENABLED } from './browser/browser-origin-policy.ts'

describe('agent-prompt', () => {
  it('includes shared placeholders and tool tail in both modes', () => {
    for (const prompt of [BASE_SYSTEM_PROMPT, BASE_SYSTEM_PROMPT_DIRECT_READS]) {
      assert.match(prompt, /\{SKILLS_TOOLS_LINE\}/)
      assert.match(prompt, /\{WORKSPACE_ROOT\}/)
      assert.match(prompt, /git_status: Show working tree status/)
      assert.match(prompt, /gh_pr_list: List pull requests/)
      assert.match(prompt, /update_todos: Create or update a structured multi-step plan/)
    }
  })

  it('uses explore in subagent mode and direct reads in the other', () => {
    assert.match(BASE_SYSTEM_PROMPT, /- explore: Explore the codebase/)
    assert.match(BASE_SYSTEM_PROMPT, /always explore before writing/)
    assert.doesNotMatch(BASE_SYSTEM_PROMPT, /- read_file: Read a file/)

    assert.match(BASE_SYSTEM_PROMPT_DIRECT_READS, /- read_file: Read a file/)
    assert.match(BASE_SYSTEM_PROMPT_DIRECT_READS, /always read before writing/)
    assert.doesNotMatch(BASE_SYSTEM_PROMPT_DIRECT_READS, /- explore: Explore the codebase/)
  })

  it('external API safety block warns about secrets', () => {
    assert.match(EXTERNAL_API_SAFETY_BLOCK, /Never hardcode, commit, or log secrets or API keys/)
    assert.match(EXTERNAL_API_SAFETY_BLOCK, /manifest\/lockfile/)
  })

  it('built-in browser tools are on by default', () => {
    assert.equal(BROWSER_TOOLS_DEFAULT_ENABLED, true)
  })

  it('browser block steers away from installing a separate browser stack', () => {
    assert.match(BROWSER_TOOLS_BLOCK, /browser_navigate/)
    assert.match(BROWSER_TOOLS_BLOCK, /do NOT install/i)
    assert.match(BROWSER_TOOLS_BLOCK, /Playwright/)
  })
})
