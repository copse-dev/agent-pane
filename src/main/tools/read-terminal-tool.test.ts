import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  __testInjectTerminalSession,
  destroyAllTerminalSessions,
  listTerminalSessions,
  readTerminalSessionOutput,
  setActiveTerminalSession,
  setTerminalSessionMeta,
} from '../services/exec/terminal-service.ts'
import { readTerminalTool } from './read-terminal-tool.ts'
import { setActiveRunThread, clearActiveRunThread } from '../services/thread-models.ts'
import { normalizeToolExecuteResult } from '@shared/types'

const signal = new AbortController().signal

async function run(args: unknown): Promise<string> {
  const result = await readTerminalTool.execute(readTerminalTool.parameters.parse(args), signal)
  return normalizeToolExecuteResult(result).result
}

describe('read_terminal tool', () => {
  beforeEach(() => {
    destroyAllTerminalSessions()
  })
  afterEach(() => {
    destroyAllTerminalSessions()
    clearActiveRunThread('thread-a')
  })

  it('list/read report no shells when empty', async () => {
    assert.match(await run({ action: 'list', max_lines: 200 }), /No open Shells/)
    assert.match(await run({ action: 'read', max_lines: 200 }), /No open Shells/)
    assert.deepEqual(listTerminalSessions(), [])
    assert.equal(readTerminalSessionOutput(undefined), null)
  })

  it('lists and reads the active shell for the running thread', async () => {
    setActiveRunThread('thread-a')
    const id = __testInjectTerminalSession({
      ownerId: 1,
      label: 'Build',
      threadId: 'thread-a',
      outputText: 'line1\nline2\nline3\n',
    })
    setActiveTerminalSession(id, 1)
    setTerminalSessionMeta(id, 1, { label: 'Build ok' })

    const listed = await run({ action: 'list', max_lines: 200 })
    assert.match(listed, /Build ok/)
    assert.match(listed, /\(active\)/)
    assert.ok(listed.includes(id))

    const read = await run({ action: 'read', max_lines: 2 })
    assert.match(read, /Shell "Build ok"/)
    assert.match(read, /line2\nline3/)
    assert.doesNotMatch(read, /line1/)

    assert.equal(listTerminalSessions('other').length, 0)
  })

  it('read by id fails for the wrong thread', async () => {
    setActiveRunThread('thread-b')
    const id = __testInjectTerminalSession({
      ownerId: 1,
      label: 'Other',
      threadId: 'thread-a',
      outputText: 'secret\n',
    })
    const result = await run({ action: 'read', id, max_lines: 200 })
    assert.match(result, /No open shell/)
  })
})
