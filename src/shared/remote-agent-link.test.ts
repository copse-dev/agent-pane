import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cursorAgentIdFromUrl } from './remote-agent-link.ts'

describe('cursorAgentIdFromUrl', () => {
  it('extracts agent ids from Cursor run URLs with optional suffixes', () => {
    assert.equal(
      cursorAgentIdFromUrl(
        'https://cursor.com/agents/bc-f048baf8-bbc6-4def-b722-4f12008284be?from=github#run',
      ),
      'bc-f048baf8-bbc6-4def-b722-4f12008284be',
    )
    assert.equal(cursorAgentIdFromUrl('https://cursor.com/agents/agent%2D1/'), 'agent-1')
  })

  it('rejects lookalike, insecure, and non-run URLs', () => {
    assert.equal(cursorAgentIdFromUrl('https://cursor.com.example/agents/agent-1'), null)
    assert.equal(cursorAgentIdFromUrl('http://cursor.com/agents/agent-1'), null)
    assert.equal(cursorAgentIdFromUrl('https://cursor.com/agents'), null)
    assert.equal(cursorAgentIdFromUrl('https://cursor.com/agents/agent-1/settings'), null)
    assert.equal(cursorAgentIdFromUrl('not a URL'), null)
  })
})
