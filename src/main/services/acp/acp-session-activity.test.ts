import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acpSessionActivity, noteAcpSessionActivity } from './acp-session-activity.ts'

describe('ACP session background activity', () => {
  it('keeps concurrent tools protected through partial updates until both complete or fail', () => {
    const session = {}
    assert.deepEqual(acpSessionActivity(session), { lastUpdateAt: 0, hasPendingTools: false })
    noteAcpSessionActivity(session, {
      sessionUpdate: 'tool_call',
      toolCallId: 'a',
      title: 'First tool',
    })
    noteAcpSessionActivity(session, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'b',
      status: 'in_progress',
    })
    noteAcpSessionActivity(session, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'a',
      title: 'Still running',
    })
    noteAcpSessionActivity(session, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'a',
      status: 'completed',
    })
    assert.equal(acpSessionActivity(session).hasPendingTools, true)
    noteAcpSessionActivity(session, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'b',
      status: 'failed',
    })
    assert.equal(acpSessionActivity(session).hasPendingTools, false)
    assert.ok(acpSessionActivity(session).lastUpdateAt > 0)
  })
})
