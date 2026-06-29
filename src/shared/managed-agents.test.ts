import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from './types/index.ts'
import {
  createManagedAgentStreamState,
  managedAgentEventToChunks,
} from './managed-agents-stream.ts'
import { buildManagedAgentSystemPrompt, MANAGED_AGENT_REPO_MOUNT_PATH } from './managed-agents.ts'

function evt(payload: Record<string, unknown>) {
  return { event: 'message', data: JSON.stringify(payload) }
}

describe('managedAgentEventToChunks', () => {
  it('maps agent.message text blocks to text chunks', () => {
    const state = createManagedAgentStreamState()
    const chunks = managedAgentEventToChunks(
      evt({ type: 'agent.message', content: [{ type: 'text', text: 'Hello' }] }),
      state,
    )
    assert.deepEqual(chunks, [{ type: 'text', text: 'Hello' }])
    assert.equal(state.assistantText, 'Hello')
  })

  it('ignores non-text content blocks in agent.message', () => {
    const state = createManagedAgentStreamState()
    const chunks = managedAgentEventToChunks(
      evt({ type: 'agent.message', content: [{ type: 'thinking', text: 'hmm' }] }),
      state,
    )
    assert.deepEqual(chunks, [])
    assert.equal(state.assistantText, '')
  })

  it('maps agent.tool_use to a tool_call chunk, deduped by id', () => {
    const state = createManagedAgentStreamState()
    const first = managedAgentEventToChunks(
      evt({ type: 'agent.tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }),
      state,
    )
    const repeat = managedAgentEventToChunks(
      evt({ type: 'agent.tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }),
      state,
    )
    assert.deepEqual(first, [
      { type: 'tool_call', toolCall: { id: 'tu_1', name: 'bash', args: { command: 'ls' } } },
    ] satisfies StreamChunk[])
    assert.deepEqual(repeat, [])
  })

  it('maps agent.tool_result to a tool_result chunk keyed by tool_use_id', () => {
    const state = createManagedAgentStreamState()
    const chunks = managedAgentEventToChunks(
      evt({
        type: 'agent.tool_result',
        tool_use_id: 'tu_1',
        content: 'README.md\nsrc',
        is_error: false,
      }),
      state,
    )
    assert.deepEqual(chunks, [
      { type: 'tool_result', toolCallId: 'tu_1', result: 'README.md\nsrc', isError: false },
    ] satisfies StreamChunk[])
  })

  it('marks the stream done on session.status_idle with the stop reason', () => {
    const state = createManagedAgentStreamState()
    const chunks = managedAgentEventToChunks(
      evt({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }),
      state,
    )
    assert.deepEqual(chunks, [])
    assert.equal(state.done, true)
    assert.equal(state.terminalStatus, 'end_turn')
  })

  it('throws on session.error', () => {
    const state = createManagedAgentStreamState()
    assert.throws(
      () =>
        managedAgentEventToChunks(
          evt({ type: 'session.error', error: { type: 'overloaded', message: 'try later' } }),
          state,
        ),
      /Claude Cloud Agent stream error \(overloaded\): try later/,
    )
  })

  it('ignores unknown event types and malformed JSON', () => {
    const state = createManagedAgentStreamState()
    assert.deepEqual(
      managedAgentEventToChunks(evt({ type: 'span.model_request_start' }), state),
      [],
    )
    assert.deepEqual(managedAgentEventToChunks({ event: 'message', data: 'not json' }, state), [])
  })
})

describe('buildManagedAgentSystemPrompt', () => {
  it('instructs a new branch and a PR by default, without leaking any token', () => {
    const prompt = buildManagedAgentSystemPrompt({
      mountPath: MANAGED_AGENT_REPO_MOUNT_PATH,
      branchPrefix: 'claude/',
      autoCreatePR: true,
      workOnCurrentBranch: false,
    })
    assert.match(prompt, /mounted at `\/workspace\/repo`/)
    assert.match(prompt, /create a new working branch named `claude\/<short-kebab-summary>`/)
    assert.match(prompt, /open a pull request using the GitHub MCP tools/)
    assert.match(prompt, /the URL of the pull request/)
    // The repo token lives only in the github_repository resource, never the prompt.
    assert.doesNotMatch(prompt, /authorization_token|ghp_|x-access-token/)
  })

  it('honors work-on-current-branch and skip-PR settings', () => {
    const prompt = buildManagedAgentSystemPrompt({
      mountPath: '/workspace/repo',
      branchPrefix: 'claude/',
      startingRef: 'develop',
      autoCreatePR: false,
      workOnCurrentBranch: true,
    })
    assert.match(prompt, /check out `develop`/)
    assert.match(prompt, /do not create a new branch/)
    assert.match(prompt, /Do not open a pull request/)
    assert.doesNotMatch(prompt, /create a new working branch/)
  })
})
