import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { openAiAgentProjectContext } from './openai-agent-project.ts'

describe('OpenAI project handoff', () => {
  it('supplies the project revision and directs cloning without discarding hosted edits', () => {
    const context = openAiAgentProjectContext(
      'https://github.com/copse-dev/agent-pane',
      'feature',
      'abc123',
    )
    assert.match(context, /https:\/\/github.com\/copse-dev\/agent-pane/)
    assert.match(context, /"branch":"feature","commit":"abc123"/)
    assert.match(context, /clone it into \/workspace\/project/)
    assert.match(context, /Preserve any existing hosted edits/)
    assert.match(context, /instead of silently using another revision/)
  })
  it('explains missing project context without inventing a repository', () => {
    assert.match(openAiAgentProjectContext(null, null, null), /No GitHub repository/)
  })
})
