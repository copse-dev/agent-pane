import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GuestProgress, summarizeToolArgs } from './guest-progress.ts'

describe('summarizeToolArgs', () => {
  it('names the one argument that says what a tool does, else a short JSON, else nothing', () => {
    assert.equal(summarizeToolArgs({ command: 'pnpm  run\n test' }), 'pnpm run test')
    assert.equal(summarizeToolArgs({ path: 'src/a.ts', line: 3 }), 'src/a.ts')
    assert.equal(summarizeToolArgs({ depth: 2 }), '{"depth":2}')
    assert.equal(summarizeToolArgs({}), '')
    assert.equal(summarizeToolArgs('x'), '')
    assert.equal(summarizeToolArgs({ command: 'x'.repeat(200) }).length, 120)
  })
})

describe('GuestProgress', () => {
  it('logs a tool call as it starts and settles, and the text the agent said before it', () => {
    const lines: string[] = []
    const progress = new GuestProgress((line) => lines.push(line))
    progress.handle({ type: 'text', text: 'Looking at ' })
    progress.handle({ type: 'text', text: 'the lint config.' })
    assert.deepEqual(lines, [], 'text waits for a boundary')
    progress.handle({
      type: 'tool_call',
      toolCall: { id: 't1', name: 'run_shell', args: { command: 'pnpm lint' } },
    })
    progress.handle({ type: 'tool_call_update', toolCallId: 't1', status: 'running' })
    progress.handle({ type: 'tool_call_update', toolCallId: 't1', status: 'done', result: 'ok' })
    progress.handle({ type: 'tool_call', toolCall: { id: 't2', name: 'read_file', args: {} } })
    progress.handle({ type: 'tool_result', toolCallId: 't2', result: 'gone', isError: true })
    progress.handle({ type: 'text', text: 'All good.' })
    progress.handle({ type: 'done' })
    progress.flush()
    assert.deepEqual(lines, [
      '[agent] Looking at the lint config.\n',
      '[agent] ▶ run_shell pnpm lint\n',
      '[agent] ✓ run_shell\n',
      '[agent] ▶ read_file\n',
      '[agent] ✗ read_file\n',
      '[agent] All good.\n',
    ])
  })

  it('takes a name from a later patch and says nothing for a call it never saw', () => {
    const lines: string[] = []
    const progress = new GuestProgress((line) => lines.push(line))
    progress.handle({ type: 'tool_call', toolCall: { id: 't1', name: 'Tool', args: null } })
    progress.handle({ type: 'tool_call_update', toolCallId: 't1', name: 'git diff --stat' })
    progress.handle({ type: 'tool_call_update', toolCallId: 't1', status: 'done' })
    progress.handle({ type: 'tool_result', toolCallId: 'never', result: '', isError: false })
    progress.handle({ type: 'usage', model: 'm', inputTokens: 1, outputTokens: 1 })
    assert.deepEqual(lines, [
      '[agent] ▶ Tool\n',
      '[agent] ✓ git diff --stat\n',
      '[agent] ✓ never\n',
    ])
  })
})
