import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  NewSessionResponse,
  SessionConfigOption,
  SessionModeState,
} from '@agentclientprotocol/sdk'
import { refreshAcpSessionState, type OpenAcpSession } from './acp-client.ts'

function state(): Pick<OpenAcpSession, 'session' | 'availableCommands' | 'sessionInfo'> {
  const modes: SessionModeState = {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
    ],
  }
  const response: NewSessionResponse = {
    sessionId: 'session-1',
    modes,
    configOptions: [],
  }
  return {
    session: { sessionId: 'session-1', response },
    availableCommands: [],
    sessionInfo: {},
  }
}

describe('ACP live session state updates', () => {
  it('replaces commands, mode, and config options for later turns', () => {
    const live = state()
    refreshAcpSessionState(live, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'research', description: 'Research the workspace', input: { hint: 'topic' } },
      ],
    })
    refreshAcpSessionState(live, {
      sessionUpdate: 'current_mode_update',
      currentModeId: 'plan',
    })
    const configOptions: SessionConfigOption[] = [
      {
        id: 'thinking',
        name: 'Thinking',
        type: 'select',
        currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      },
    ]
    refreshAcpSessionState(live, {
      sessionUpdate: 'config_option_update',
      configOptions,
    })

    assert.deepEqual(live.availableCommands, [
      { name: 'research', description: 'Research the workspace', input: { hint: 'topic' } },
    ])
    assert.equal(live.session.response.modes?.currentModeId, 'plan')
    assert.deepEqual(live.session.response.configOptions, configOptions)
  })

  it('patches and explicitly clears session metadata', () => {
    const live = state()
    refreshAcpSessionState(live, {
      sessionUpdate: 'session_info_update',
      title: 'Agent title',
      updatedAt: '2026-09-22T00:00:00Z',
    })
    assert.deepEqual(live.sessionInfo, {
      title: 'Agent title',
      updatedAt: '2026-09-22T00:00:00Z',
    })

    refreshAcpSessionState(live, {
      sessionUpdate: 'session_info_update',
      title: null,
    })
    assert.deepEqual(live.sessionInfo, { updatedAt: '2026-09-22T00:00:00Z' })
  })
})
