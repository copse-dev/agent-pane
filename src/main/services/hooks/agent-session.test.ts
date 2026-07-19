// B4: the host-side agent-session identity builder. Verifies model identity is
// sourced from the model catalog as Cursor's `{ id, value }[]` params, and that
// `currentAgentSessionInfo` reads ambient run state (thread / turn / model) with
// overridable fields — the source the dialect adapters stamp on wire payloads.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildHookModelIdentity, currentAgentSessionInfo } from './agent-session.ts'
import {
  runWithActiveRunIdentity,
  setActiveRunThread,
  setActiveRunModel,
} from '../thread-models.ts'
import { beginHookRunRecording, endHookRunRecording } from '../hook-run-recorder.ts'
import { storageSet } from '../storage/storage.ts'

describe('agent-session (B4)', () => {
  describe('buildHookModelIdentity', () => {
    it('reports catalog params as an { id, value } array for a known model', () => {
      const identity = buildHookModelIdentity('claude-sonnet-4-6')
      assert.equal(identity.model, 'claude-sonnet-4-6')
      assert.equal(identity.modelId, 'claude-sonnet-4-6')
      assert.ok(Array.isArray(identity.modelParams))
      assert.ok(identity.modelParams.some((p) => p.id === 'context_window'))
      assert.ok(identity.modelParams.some((p) => p.id === 'max_output_tokens'))
      // Every entry is a string { id, value } pair (Cursor's shape).
      for (const p of identity.modelParams) {
        assert.equal(typeof p.id, 'string')
        assert.equal(typeof p.value, 'string')
      }
    })

    it('yields a valid identity with empty params for an off-catalog (local) model', () => {
      const identity = buildHookModelIdentity('lmstudio:some-local-model')
      assert.equal(identity.model, 'lmstudio:some-local-model')
      assert.equal(identity.modelId, 'lmstudio:some-local-model')
      assert.deepEqual(identity.modelParams, [])
    })
  })

  describe('currentAgentSessionInfo', () => {
    afterEach(() => {
      endHookRunRecording('t-session')
    })

    it('reads ambient thread + turn + model when set', () => {
      runWithActiveRunIdentity('t-session', () => {
        setActiveRunThread('t-session')
        setActiveRunModel('claude-sonnet-4-6')
        // beginHookRunRecording only mints a turn id when a project is active.
        storageSet('activeProjectId', 'proj-agent-session')
        beginHookRunRecording('t-session')
        const info = currentAgentSessionInfo()
        assert.equal(info.conversationId, 't-session')
        assert.ok(info.generationId.length > 0, 'generation id comes from the recording turn id')
        assert.equal(info.model?.modelId, 'claude-sonnet-4-6')
      })
    })

    it('honours overrides and omits model when explicitly null', () => {
      runWithActiveRunIdentity('t-session', () => {
        setActiveRunThread('t-session')
        setActiveRunModel('claude-sonnet-4-6')
        const info = currentAgentSessionInfo({ conversationId: 'override', model: null })
        assert.equal(info.conversationId, 'override')
        assert.equal(info.model, undefined)
      })
    })

    it('degrades to empty ids and no model outside an active run', () => {
      const info = currentAgentSessionInfo()
      assert.equal(info.conversationId, '')
      assert.equal(info.generationId, '')
      assert.equal(info.model, undefined)
    })
  })
})
