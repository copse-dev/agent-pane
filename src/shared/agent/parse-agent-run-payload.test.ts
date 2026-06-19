import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentRunPayload } from './parse-agent-run-payload.ts'

describe('parseAgentRunPayload', () => {
  it('parses plain text prompts', () => {
    assert.deepEqual(parseAgentRunPayload('hello'), {
      userContent: 'hello',
      invokedSkills: [],
    })
  })

  it('parses rich content payloads with invoked skills', () => {
    const payload = {
      content: 'do the thing',
      invokedSkills: ['demo-skill'],
    }
    assert.deepEqual(parseAgentRunPayload(JSON.stringify(payload)), {
      userContent: 'do the thing',
      invokedSkills: ['demo-skill'],
    })
  })
})
