import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Thread, ToolCall } from '@shared/types'
import { agentActivityLabel, promptProgressLabel } from './agent-activity.ts'

function thread(toolCalls: ToolCall[]): Thread {
  return {
    id: 't',
    title: 't',
    status: 'running',
    messages: [{ id: 'm1', role: 'assistant', content: '', toolCalls, createdAt: 1 }],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function agentCall(id: string, subagentType: string, status: ToolCall['status']): ToolCall {
  return {
    id,
    name: 'Agent',
    kind: 'think',
    args: { subagent_type: subagentType, prompt: 'research' },
    status,
    result: status === 'running' ? null : 'done',
  }
}

describe('promptProgressLabel', () => {
  it('renders a rounded percentage', () => {
    assert.equal(promptProgressLabel(0), 'Processing prompt… 0%')
    assert.equal(promptProgressLabel(0.474), 'Processing prompt… 47%')
    assert.equal(promptProgressLabel(1), 'Processing prompt… 100%')
  })

  it('clamps out-of-range values and treats non-finite input as indeterminate', () => {
    assert.equal(promptProgressLabel(-0.2), 'Processing prompt… 0%')
    assert.equal(promptProgressLabel(1.5), 'Processing prompt… 100%')
    assert.equal(promptProgressLabel(Number.NaN), 'Processing prompt…')
  })

  it('collapses sub-percent steps to the same label, which the controller dedupes on', () => {
    // The controller emits only when the label changes; these five fractions
    // arrive in sequence during one prefill and collapse to two distinct labels,
    // so only two of them reach the aria-live region.
    const labels = [0.471, 0.473, 0.4749, 0.475, 0.481].map(promptProgressLabel)
    assert.deepEqual(labels, [
      'Processing prompt… 47%',
      'Processing prompt… 47%',
      'Processing prompt… 47%',
      'Processing prompt… 48%',
      'Processing prompt… 48%',
    ])
  })
})

describe('agentActivityLabel', () => {
  it('names a single ACP subagent dispatch by its kind', () => {
    const t = thread([agentCall('a1', 'Explore', 'running')])
    assert.equal(agentActivityLabel(t, false), 'Running Explore…')
  })

  it('counts several concurrent ACP subagent dispatches instead of naming only one', () => {
    const t = thread([
      agentCall('a1', 'Explore', 'running'),
      agentCall('a2', 'Explore', 'running'),
      agentCall('a3', 'Explore', 'done'),
      agentCall('a4', 'Explore', 'running'),
    ])
    assert.equal(agentActivityLabel(t, false), 'Running 3 Explore agents…')
  })

  it('drops the shared kind when concurrent dispatches differ', () => {
    const t = thread([
      agentCall('a1', 'Explore', 'running'),
      agentCall('a2', 'Investigate', 'running'),
    ])
    assert.equal(agentActivityLabel(t, false), 'Running 2 agents…')
  })

  it('falls back to the generic agent label when no subagent_type is reported', () => {
    const t = thread([
      { id: 'a1', name: 'Agent', kind: 'think', args: {}, status: 'running', result: null },
    ])
    assert.equal(agentActivityLabel(t, false), 'Running agent…')
  })

  it('keeps the existing single-tool label for non-delegate running tools', () => {
    const t = thread([{ id: 'r1', name: 'run_shell', args: {}, status: 'running', result: null }])
    assert.equal(agentActivityLabel(t, false), 'Running command…')
  })
})
