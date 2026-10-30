import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { IpcValidationError, parseIpcArgs, zProjectId, zThreadId } from './ipc-guards.ts'
import {
  argumentListIpcHandler,
  parsePositionalIpcArgs,
  positionalIpcHandler,
  senderCheck,
} from './ipc-handler.ts'

/** A sender check that accepts only the event `'app'`, standing in for `assertMainFrameSender`. */
function appOnly(event: string): void {
  if (event !== 'app')
    throw new IpcValidationError('Request rejected: it did not come from the app window')
}

const PROJECT = 'proj-1'
const THREAD = 'thread-1'

/** The outcome of a call: its value, or the error's class and message. */
function outcome(run: () => unknown): unknown {
  try {
    return { ok: run() }
  } catch (error) {
    assert.ok(error instanceof Error)
    return { error: error.name, message: error.message }
  }
}

// Argument lists a renderer could send: none, too few, valid, wrong types,
// extra trailing values, and a whole tuple wrapped in one array.
const ARGUMENT_LISTS: unknown[][] = [
  [],
  [undefined],
  [PROJECT],
  [42],
  [PROJECT, THREAD],
  [PROJECT, 42],
  [42, 42],
  [PROJECT, THREAD, 'extra'],
  [PROJECT, THREAD, 'extra', 'more'],
  [[PROJECT, THREAD]],
  [null],
  [''],
]

describe('parsePositionalIpcArgs matches the hand-written handlers it replaces', () => {
  it('one optional argument: parseIpcArgs(schema, [raw]) (decisions:list, decisions:export)', () => {
    const schema = zProjectId.optional()
    const handWritten = (rawProjectId: unknown): unknown => parseIpcArgs(schema, [rawProjectId])
    const adopted = z.tuple([schema])
    for (const rawArgs of ARGUMENT_LISTS) {
      assert.deepEqual(
        outcome(() => parsePositionalIpcArgs(adopted, rawArgs)[0]),
        outcome(() => handWritten(rawArgs[0])),
        JSON.stringify(rawArgs),
      )
    }
  })

  it('one required argument keeps the single-argument error, with no tuple index', () => {
    const raw = 42
    const expected = outcome(() => parseIpcArgs(zProjectId, [raw]))
    assert.deepEqual(
      outcome(() => parsePositionalIpcArgs(z.tuple([zProjectId]), [raw])),
      expected,
    )
    assert.doesNotMatch(JSON.stringify(expected), /"path": \[\s*0/)
  })

  it('two arguments: parseIpcArgs(tuple, [a, b]) (decisions:list-thread)', () => {
    const schema = z.tuple([zProjectId, zThreadId])
    const handWritten = (projectId: unknown, threadId: unknown): unknown =>
      parseIpcArgs(schema, [projectId, threadId])
    for (const rawArgs of ARGUMENT_LISTS) {
      assert.deepEqual(
        outcome(() => parsePositionalIpcArgs(schema, rawArgs)),
        outcome(() => handWritten(rawArgs[0], rawArgs[1])),
        JSON.stringify(rawArgs),
      )
    }
  })

  it('a value the hand-written check validates itself: z.unknown() passes it through', () => {
    for (const rawArgs of ARGUMENT_LISTS) {
      assert.deepEqual(parsePositionalIpcArgs(z.tuple([z.unknown()]), rawArgs), [rawArgs[0]])
    }
  })

  it('no arguments: every argument list is accepted and ignored', () => {
    for (const rawArgs of ARGUMENT_LISTS) {
      assert.deepEqual(parsePositionalIpcArgs(z.tuple([]), rawArgs), [])
    }
  })

  it('throws IpcValidationError', () => {
    assert.throws(
      () => parsePositionalIpcArgs(z.tuple([zProjectId, zThreadId]), [42]),
      IpcValidationError,
    )
  })
})

describe('argumentListIpcHandler matches parseIpcArgs(schema, rawArgs)', () => {
  it('usage:get-thread-classifier-use: extra arguments rejected, a wrapped tuple accepted', () => {
    const schema = z.tuple([zProjectId, zThreadId])
    const handWritten = (...rawArgs: unknown[]): unknown => parseIpcArgs(schema, rawArgs)
    const adopted = argumentListIpcHandler(appOnly, schema, (parsed) => parsed)
    for (const rawArgs of ARGUMENT_LISTS) {
      assert.deepEqual(
        outcome(() => adopted('app', ...rawArgs)),
        outcome(() => handWritten(...rawArgs)),
        JSON.stringify(rawArgs),
      )
    }
    assert.deepEqual(adopted('app', [PROJECT, THREAD]), [PROJECT, THREAD])
    assert.throws(() => adopted('app', PROJECT, THREAD, 'extra'), IpcValidationError)
  })
})

describe('sender guard', () => {
  it('rejects the sender before parsing or calling the handler', () => {
    let calls = 0
    const positional = positionalIpcHandler(appOnly, z.tuple([zProjectId]), () => ++calls)
    const argumentList = argumentListIpcHandler(appOnly, zProjectId, () => ++calls)
    // Invalid arguments too: the sender error must win over the validation error.
    for (const listener of [positional, argumentList]) {
      assert.throws(() => listener('webview', 42), /did not come from the app window/)
      assert.throws(() => listener('webview', PROJECT), /did not come from the app window/)
    }
    assert.equal(calls, 0)
    assert.equal(positional('app', PROJECT), 1)
    assert.equal(argumentList('app', PROJECT), 2)
  })

  // A boot window closed while a webview is still sending: no trusted frame matches.
  const closedBootWindow = {
    isDestroyed: (): boolean => true,
    get webContents(): never {
      throw new TypeError('Object has been destroyed')
    },
  }

  it('checks the main frame by default and for an explicit main-frame option', () => {
    for (const check of [
      senderCheck(closedBootWindow),
      senderCheck(closedBootWindow, {}),
      senderCheck(closedBootWindow, { sender: 'main-frame' }),
    ]) {
      assert.throws(() => {
        check({ senderFrame: null })
      }, /did not come from the app window/)
    }
  })

  it("{ sender: 'any' } skips the check, as the unguarded usage handlers did", () => {
    const listener = positionalIpcHandler(
      senderCheck(closedBootWindow, { sender: 'any' }),
      z.tuple([z.boolean().optional()]),
      (force) => force,
    )
    assert.equal(listener({ senderFrame: null }, true), true)
    assert.equal(listener({ senderFrame: null }), undefined)
    assert.throws(() => listener({ senderFrame: null }, 'yes'), IpcValidationError)
  })
})
