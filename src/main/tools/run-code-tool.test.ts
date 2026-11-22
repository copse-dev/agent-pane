import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeToolExecuteResult } from '@shared/types'
import { setSetting } from '../services/storage/settings.ts'
import { CODE_MODE_ENABLED_SETTING } from '../services/code-mode/code-mode-service.ts'
import { CodeCellPool } from '../services/code-mode/code-cell-pool.ts'
import { CellToolSession, type CellToolHost } from '../services/code-mode/code-cell-tools.ts'
import type { CellOutcome } from '../services/code-mode/code-cell-container.ts'
import { createRunCodeTool, formatCellOutcome } from './run-code-tool.ts'

const host: CellToolHost = {
  has: () => true,
  provenanceOf: () => 'workspace',
  executeNormalized: () => Promise.resolve({ result: '' }),
}

function session(): CellToolSession {
  return new CellToolSession(host, (fn) => fn())
}

function result(fields: Partial<{ value: string; logs: string; truncated: boolean }>): CellOutcome {
  return {
    kind: 'result',
    result: { id: 1, ok: true, value: '', logs: '', truncated: false, ...fields },
  }
}

describe('formatCellOutcome', () => {
  it('shows console output before the returned value', () => {
    assert.equal(
      formatCellOutcome(result({ value: '42', logs: 'one\ntwo\n' }), session()),
      'Console:\none\ntwo\n\nReturned:\n42',
    )
  })

  it('says when a cell returned nothing', () => {
    assert.equal(formatCellOutcome(result({}), session()), 'Returned nothing.')
  })

  it('shows what a cell threw and how many tools it called', async () => {
    const tools = session()
    await tools.handle('read_file', {}, new AbortController().signal)
    assert.equal(
      formatCellOutcome(
        {
          kind: 'result',
          result: { id: 1, ok: false, error: 'Error: boom', logs: '', truncated: true },
        },
        tools,
      ),
      'The cell threw:\nError: boom\n\n(The cell produced more output than a cell may return; the rest was dropped.)\n\n(1 tool call)',
    )
  })

  it('says the state is gone whenever the container was discarded', () => {
    for (const outcome of [
      { kind: 'timeout' },
      { kind: 'aborted' },
      { kind: 'failed', error: 'the link closed' },
    ] satisfies CellOutcome[]) {
      assert.match(formatCellOutcome(outcome, session()), /values saved on `state` are gone/)
    }
  })
})

const POOL_OPTIONS = {
  sweep: (): Promise<void> => Promise.resolve(),
  idleMs: 60_000,
  maxLeases: 4,
  now: Date.now,
  log: (): void => {},
}

describe('run_code', () => {
  afterEach(async () => {
    await setSetting(CODE_MODE_ENABLED_SETTING, false)
  })

  it('refuses to run while code mode is off', async () => {
    let started = 0
    const pool = new CodeCellPool({
      ...POOL_OPTIONS,
      start: (): Promise<never> => {
        started += 1
        return Promise.reject(new Error('should not start'))
      },
    })
    const tool = createRunCodeTool(host, () => pool)
    const output = await tool.execute({ code: 'return 1' }, new AbortController().signal)
    assert.match(normalizeToolExecuteResult(output).result, /Code mode is off/)
    assert.equal(started, 0)
  })

  it('refuses to run outside a thread', async () => {
    await setSetting(CODE_MODE_ENABLED_SETTING, true)
    const pool = new CodeCellPool({
      ...POOL_OPTIONS,
      start: (): Promise<never> => Promise.reject(new Error('should not start')),
    })
    const tool = createRunCodeTool(host, () => pool)
    const output = await tool.execute({ code: 'return 1' }, new AbortController().signal)
    assert.match(normalizeToolExecuteResult(output).result, /only inside a thread/)
    await pool.disable()
  })

  it('takes TypeScript up to the source limit and a bounded timeout', () => {
    const tool = createRunCodeTool(host)
    assert.equal(tool.parameters.safeParse({ code: '' }).success, false)
    assert.equal(tool.parameters.safeParse({ code: 'return 1', timeout_seconds: 0 }).success, false)
    assert.equal(
      tool.parameters.safeParse({ code: 'return 1', timeout_seconds: 301 }).success,
      false,
    )
    assert.equal(tool.parameters.safeParse({ code: 'return 1', timeout_seconds: 30 }).success, true)
  })
})
