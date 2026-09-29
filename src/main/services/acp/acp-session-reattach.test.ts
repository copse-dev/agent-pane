import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import {
  acpReattachMethods,
  acpSessionHandoverNotice,
  noReattachMethodFailure,
  splitLoadReplay,
} from './acp-session-reattach.ts'

describe('acpReattachMethods', () => {
  it('prefers resume, then load, in the same directory', () => {
    assert.deepEqual(acpReattachMethods({ resume: true, load: true }, false), ['resume', 'load'])
    assert.deepEqual(acpReattachMethods({ resume: true, load: false }, false), ['resume'])
    assert.deepEqual(acpReattachMethods({ resume: false, load: true }, false), ['load'])
    assert.deepEqual(acpReattachMethods({ resume: false, load: false }, false), [])
  })

  it('only loads after a move, because only a load proves the session was found', () => {
    assert.deepEqual(acpReattachMethods({ resume: true, load: true }, true), ['load'])
    assert.deepEqual(acpReattachMethods({ resume: false, load: true }, true), ['load'])
    assert.deepEqual(acpReattachMethods({ resume: true, load: false }, true), [])
  })
})

describe('noReattachMethodFailure', () => {
  it('names the move when resume alone could not follow it', () => {
    assert.equal(noReattachMethodFailure({ resume: true, load: false }, true), 'moved-without-load')
    assert.equal(noReattachMethodFailure({ resume: false, load: false }, true), 'unsupported')
    assert.equal(noReattachMethodFailure({ resume: false, load: false }, false), 'unsupported')
  })
})

describe('splitLoadReplay', () => {
  const text = (
    kind: 'user_message_chunk' | 'agent_message_chunk',
    value: string,
  ): SessionUpdate => ({
    sessionUpdate: kind,
    content: { type: 'text', text: value },
  })

  it('drops the replayed conversation and keeps live session state', () => {
    const commands: SessionUpdate = {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    }
    const split = splitLoadReplay([
      text('user_message_chunk', 'hi'),
      text('agent_message_chunk', 'hello'),
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file' },
      commands,
    ])
    assert.deepEqual(split, { keep: [commands], replayed: 3, foundConversation: true })
  })

  it('does not count an agent-only replay as the conversation being found', () => {
    assert.equal(splitLoadReplay([text('agent_message_chunk', 'hello')]).foundConversation, false)
    assert.equal(splitLoadReplay([]).foundConversation, false)
  })
})

describe('acpSessionHandoverNotice', () => {
  it('names the move and what did not carry over', () => {
    const notice = acpSessionHandoverNotice(
      { reason: 'moved-without-load', fromCwd: '/repo', toCwd: '/repo/.worktrees/t1' },
      'Cursor',
    )
    assert.match(notice, /Cursor lost its earlier session/)
    assert.match(notice, /`\/repo\/\.worktrees\/t1` instead of `\/repo`/)
    assert.match(notice, /your messages and its replies carry over/)
    assert.match(notice, /tool calls and their output, the files it read, and its reasoning do not/)
  })

  it('explains an empty load without claiming the agent moved', () => {
    const notice = acpSessionHandoverNotice(
      { reason: 'history-missing', fromCwd: '/repo', toCwd: '/repo' },
      'Codex',
    )
    assert.match(
      notice,
      /Codex lost its earlier session\.\*\* It restarted and reopened its previous session, but with none/,
    )
    assert.doesNotMatch(notice, /`\/repo`/)
  })
})
