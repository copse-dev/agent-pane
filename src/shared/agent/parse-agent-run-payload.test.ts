import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentRunPayload } from './parse-agent-run-payload.ts'

describe('parseAgentRunPayload', () => {
  it('parses plain text prompts', () => {
    assert.deepEqual(parseAgentRunPayload('hello'), {
      userContent: 'hello',
      invokedSkills: [],
      priorTodos: [],
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
      priorTodos: [],
    })
  })

  it('parses prior todos from payload', () => {
    const payload = {
      content: 'continue',
      priorTodos: [{ id: 't1', content: 'Step one', status: 'completed' as const }],
    }
    const r = parseAgentRunPayload(JSON.stringify(payload))
    assert.equal(r.priorTodos.length, 1)
    assert.equal(r.priorTodos[0]?.content, 'Step one')
  })
})
