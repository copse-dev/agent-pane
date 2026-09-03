import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCall } from '@shared/types'
import { deriveToolRuns, toolRunForMessage, type ToolRunMessage } from './tool-runs.ts'

function tc(id: string, name = 'read_file', status: ToolCall['status'] = 'done'): ToolCall {
  return { id, name, args: {}, status, result: status === 'running' ? null : 'ok' }
}

function subagent(id: string): ToolCall {
  return {
    ...tc(id, 'task'),
    subagent: { sessionId: `s-${id}`, agentName: 'Explore', status: 'done', messages: [] },
  }
}

function assistant(id: string, extra: Partial<ToolRunMessage> = {}): ToolRunMessage {
  return { id, role: 'assistant', content: '', toolCalls: [], ...extra }
}

function user(id: string): ToolRunMessage {
  return { id, role: 'user', content: 'do the thing', toolCalls: [] }
}

/** Tool calls named after their owning message, `n` of them. */
function tools(msgId: string, n: number): ToolCall[] {
  return Array.from({ length: n }, (_unused, i) => tc(`${msgId}-${String(i)}`))
}

describe('tool-runs', () => {
  it('joins tool-only assistant messages onto the message that started the burst', () => {
    // The recorded topology: a prompt, a commentary message with tools, then
    // seven tool-only segments — one run, not eight rows.
    const messages: ToolRunMessage[] = [
      user('u1'),
      assistant('a1', { content: 'On it.', toolCalls: tools('a1', 6) }),
      assistant('a2', { toolCalls: tools('a2', 6) }),
      assistant('a3', { toolCalls: tools('a3', 6) }),
      assistant('a4', { toolCalls: tools('a4', 2) }),
      assistant('a5', { toolCalls: tools('a5', 2) }),
    ]

    const runs = deriveToolRuns(messages)
    assert.equal(runs.length, 1)
    assert.equal(runs[0]?.anchorId, 'a1')
    assert.deepEqual(runs[0]?.memberIds, ['a1', 'a2', 'a3', 'a4', 'a5'])
    assert.equal(runs[0]?.steps.length, 5)
    assert.equal(runs[0]?.toolCalls.length, 22)
    // Chronological: every step's calls sit in message order.
    assert.deepEqual(
      runs[0]?.toolCalls.slice(0, 2).map((call) => call.id),
      ['a1-0', 'a1-1'],
    )
    assert.equal(runs[0]?.toolCalls.at(-1)?.id, 'a5-1')
  })

  it('ends a run at the next visible assistant response and starts a new one after it', () => {
    const messages: ToolRunMessage[] = [
      user('u1'),
      assistant('a1', { toolCalls: tools('a1', 3) }),
      assistant('a2', { toolCalls: tools('a2', 2) }),
      assistant('a3', { content: 'Local picture looks good.', toolCalls: tools('a3', 4) }),
      assistant('a4', { toolCalls: tools('a4', 1) }),
      assistant('a5', { content: 'All green.' }),
    ]

    const runs = deriveToolRuns(messages)
    assert.deepEqual(
      runs.map((run) => run.memberIds),
      [
        ['a1', 'a2'],
        ['a3', 'a4'],
      ],
    )
  })

  it('ends a run at a prompt, whatever its origin', () => {
    const machinePrompt: ToolRunMessage = {
      id: 'm1',
      role: 'user',
      content: 'follow-up',
      toolCalls: [],
    }
    const messages: ToolRunMessage[] = [
      assistant('a1', { toolCalls: tools('a1', 2) }),
      machinePrompt,
      assistant('a2', { toolCalls: tools('a2', 2) }),
    ]

    assert.deepEqual(
      deriveToolRuns(messages).map((run) => run.memberIds),
      [['a1'], ['a2']],
    )
  })

  it('absorbs a reasoning-only segment but not an empty one', () => {
    const withReasoning: ToolRunMessage[] = [
      assistant('a1', { toolCalls: tools('a1', 2) }),
      assistant('a2', { reasoning: 'Weighing the next move.' }),
      assistant('a3', { toolCalls: tools('a3', 1) }),
    ]
    assert.deepEqual(
      deriveToolRuns(withReasoning).map((run) => run.memberIds),
      [['a1', 'a2', 'a3']],
    )

    const withGap: ToolRunMessage[] = [
      assistant('a1', { toolCalls: tools('a1', 2) }),
      assistant('a2'),
      assistant('a3', { toolCalls: tools('a3', 1) }),
    ]
    assert.deepEqual(
      deriveToolRuns(withGap).map((run) => run.memberIds),
      [['a1'], ['a3']],
    )
  })

  it('leaves subagent-only segments out of runs and out of a run’s calls', () => {
    const messages: ToolRunMessage[] = [
      assistant('a1', { toolCalls: [...tools('a1', 2), subagent('sub-1')] }),
      assistant('a2', { toolCalls: [subagent('sub-2')] }),
      assistant('a3', { toolCalls: tools('a3', 1) }),
    ]

    const runs = deriveToolRuns(messages)
    // a2 carries only a subagent, so it neither joins a run nor starts one —
    // its timeline card stays top-level on its own message.
    assert.deepEqual(
      runs.map((run) => run.memberIds),
      [['a1'], ['a3']],
    )
    assert.deepEqual(
      runs[0]?.toolCalls.map((call) => call.id),
      ['a1-0', 'a1-1'],
    )
  })

  it('carries each message’s own polish as its step heading and the anchor’s as the run summary', () => {
    const messages: ToolRunMessage[] = [
      assistant('a1', {
        toolCalls: tools('a1', 2),
        toolSummary: 'Read the settings UI',
        runSummary: 'Checked CI, branch state, and test coverage',
      }),
      assistant('a2', { toolCalls: tools('a2', 2), toolSummary: 'Inspected the repo layout' }),
    ]

    const run = deriveToolRuns(messages)[0]
    assert.equal(run?.summary, 'Checked CI, branch state, and test coverage')
    assert.deepEqual(
      run?.steps.map((step) => step.summary),
      ['Read the settings UI', 'Inspected the repo layout'],
    )
  })

  it('resolves the same run from any member, and none for a message outside one', () => {
    const messages: ToolRunMessage[] = [
      user('u1'),
      assistant('a1', { content: 'On it.', toolCalls: tools('a1', 2) }),
      assistant('a2', { toolCalls: tools('a2', 2) }),
      assistant('a3', { toolCalls: tools('a3', 2) }),
      assistant('a4', { content: 'Done.' }),
    ]

    for (const id of ['a1', 'a2', 'a3']) {
      assert.deepEqual(toolRunForMessage(messages, id)?.memberIds, ['a1', 'a2', 'a3'], id)
      assert.equal(toolRunForMessage(messages, id)?.anchorId, 'a1', id)
    }
    assert.equal(toolRunForMessage(messages, 'u1'), null)
    assert.equal(toolRunForMessage(messages, 'a4'), null)
    assert.equal(toolRunForMessage(messages, 'nope'), null)
  })

  it('resolves a run whose anchor is itself tool-only (the first segment after a prompt)', () => {
    // The windowed lookup must walk back past the anchor, which is absorbable in
    // its own right, without stopping short at it.
    const messages: ToolRunMessage[] = [
      user('u1'),
      assistant('a1', { toolCalls: tools('a1', 2) }),
      assistant('a2', { toolCalls: tools('a2', 2) }),
    ]

    assert.deepEqual(toolRunForMessage(messages, 'a2')?.memberIds, ['a1', 'a2'])
    assert.deepEqual(deriveToolRuns(messages), [toolRunForMessage(messages, 'a2')])
  })

  it('agrees with the full derivation for every message in a long thread', () => {
    const messages: ToolRunMessage[] = [
      user('u1'),
      assistant('a1', { toolCalls: tools('a1', 1) }),
      assistant('a2', { reasoning: 'hmm' }),
      assistant('a3', { toolCalls: tools('a3', 3) }),
      assistant('a4', { content: 'Interim answer.' }),
      user('u2'),
      assistant('a5', { content: 'Next.', toolCalls: tools('a5', 2) }),
      assistant('a6', { toolCalls: tools('a6', 2) }),
      assistant('a7', { content: 'Final.' }),
    ]

    const byMember = new Map(
      deriveToolRuns(messages).flatMap((run) => run.memberIds.map((id) => [id, run] as const)),
    )
    for (const msg of messages) {
      assert.deepEqual(
        toolRunForMessage(messages, msg.id),
        byMember.get(msg.id) ?? null,
        `run for ${msg.id}`,
      )
    }
  })
})
