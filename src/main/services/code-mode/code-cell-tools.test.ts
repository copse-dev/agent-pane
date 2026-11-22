import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { READONLY_AGENT_TOOLS } from '@shared/tools/readonly-tools.ts'
import {
  CellToolSession,
  CODE_CELL_MAX_TOOL_CALLS,
  CODE_CELL_TOOLS,
  splitAppendedReminders,
  type CellToolHost,
  type InTurn,
} from './code-cell-tools.ts'

function host(
  overrides: Partial<CellToolHost> = {},
  calls: Array<{ name: string; args: unknown }> = [],
): CellToolHost {
  return {
    has: (name): boolean => CODE_CELL_TOOLS.includes(name),
    provenanceOf: (): 'workspace' => 'workspace',
    executeNormalized: (name, args): Promise<{ result: string }> => {
      calls.push({ name, args })
      return Promise.resolve({ result: `${name} ok` })
    },
    ...overrides,
  }
}

const direct: InTurn = (fn) => fn()
const signal = new AbortController().signal

describe('CODE_CELL_TOOLS', () => {
  it('lists only tools a read-only run may call', () => {
    assert.deepEqual(
      CODE_CELL_TOOLS.filter((name) => !READONLY_AGENT_TOOLS.has(name)),
      [],
    )
  })
})

describe('CellToolSession', () => {
  it('runs an allowed tool in the turn and hands back its text', async () => {
    const calls: Array<{ name: string; args: unknown }> = []
    let entered = 0
    const inTurn: InTurn = (fn) => {
      entered += 1
      return fn()
    }
    const session = new CellToolSession(host({}, calls), inTurn)
    assert.deepEqual(await session.handle('read_file', { path: 'a.ts' }, signal), {
      ok: true,
      result: 'read_file ok',
    })
    assert.deepEqual(calls, [{ name: 'read_file', args: { path: 'a.ts' } }])
    assert.equal(entered, 1, 'the call ran inside the turn context')
    assert.equal(session.calls, 1)
  })

  it('refuses a tool outside the list, naming what is available', async () => {
    const session = new CellToolSession(
      host({ has: (name) => name === 'read_file' || name === 'run_shell' }),
      direct,
    )
    const reply = await session.handle('run_shell', { command: 'rm -rf /' }, signal)
    assert.equal(reply.ok, false)
    assert.match(reply.error, /tools\.run_shell is not available/)
    assert.match(reply.error, /Available: read_file\./)
    assert.equal(session.calls, 0)
  })

  it('refuses an allowed tool that is not registered right now', async () => {
    const session = new CellToolSession(host({ has: () => false }), direct)
    const reply = await session.handle('git_show', {}, signal)
    assert.equal(reply.ok, false)
  })

  it('stops a cell after the call limit', async () => {
    const session = new CellToolSession(host(), direct)
    for (let i = 0; i < CODE_CELL_MAX_TOOL_CALLS; i += 1) {
      assert.equal((await session.handle('list_dir', {}, signal)).ok, true)
    }
    const reply = await session.handle('list_dir', {}, signal)
    assert.equal(reply.ok, false)
    assert.match(reply.error, /at most 100 tool calls/)
  })

  it('turns a thrown tool error into a refusal the cell can catch', async () => {
    const session = new CellToolSession(
      host({ executeNormalized: () => Promise.reject(new Error('Unknown file')) }),
      direct,
    )
    assert.deepEqual(await session.handle('read_file', { path: 'x' }, signal), {
      ok: false,
      error: 'Unknown file',
    })
  })

  it('lifts appended system reminders off the result for the model', async () => {
    const reminder = '<system-reminder>\nA hook said hello.\n</system-reminder>'
    const session = new CellToolSession(
      host({
        executeNormalized: () =>
          Promise.resolve({
            result: `file body\n\n${reminder}`,
            appendedReminderLengths: [reminder.length],
          }),
      }),
      direct,
    )
    assert.deepEqual(await session.handle('read_file', { path: 'x' }, signal), {
      ok: true,
      result: 'file body',
    })
    assert.deepEqual(session.reminders, [reminder])
  })

  it('marks the session external when a tool authors external results', async () => {
    const session = new CellToolSession(
      host({ provenanceOf: (name) => (name === 'git_show' ? 'external' : 'workspace') }),
      direct,
    )
    await session.handle('read_file', {}, signal)
    assert.equal(session.external, false)
    await session.handle('git_show', {}, signal)
    assert.equal(session.external, true)
  })

  it('counts images a cell cannot receive', async () => {
    const session = new CellToolSession(
      host({
        executeNormalized: () => Promise.resolve({ result: 'shot', images: [{}, {}] }),
      }),
      direct,
    )
    await session.handle('read_file', {}, signal)
    assert.equal(session.imagesDropped, 2)
  })
})

describe('splitAppendedReminders', () => {
  it('splits several blocks in order', () => {
    const one = '<system-reminder>one</system-reminder>'
    const two = '<system-reminder>two</system-reminder>'
    assert.deepEqual(splitAppendedReminders(`body\n\n${one}\n\n${two}`, [one.length, two.length]), {
      body: 'body',
      reminders: [one, two],
    })
  })

  it('leaves a result alone when the lengths do not fit it', () => {
    assert.deepEqual(splitAppendedReminders('short', [100]), { body: 'short', reminders: [] })
    assert.deepEqual(splitAppendedReminders('plain', undefined), { body: 'plain', reminders: [] })
  })
})
