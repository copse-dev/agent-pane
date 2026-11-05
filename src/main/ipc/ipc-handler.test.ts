import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { classifierProfileSchema } from '@copse/llm/classifiers/schemas.ts'
import { TOOL_PERMISSION_POLICIES } from '@shared/types/tool-permissions.ts'
import { prRefSchema } from '@shared/git/thread-pr-relations.ts'
import { ghCreatePrForThreadArgs, ghPrFileDiffArgs, ghPrRefArgs } from './gh-handler-args.ts'
import {
  IpcValidationError,
  parseIpcArgs,
  zNonEmptyString,
  zPathString,
  zPrComposerCreateRequest,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import {
  argumentListIpcHandler,
  parsePositionalIpcArgs,
  positionalIpcHandler,
  senderCheck,
  senderPositionalIpcHandler,
  type PositionalArgsOptions,
} from './ipc-handler.ts'
import {
  classifierIdArgs,
  classifierIdOrNullArgs,
  classifierSaveArgs,
  environmentSetupApplyArgs,
  environmentSetupDismissArgs,
  environmentSetupUndoArgs,
  toolPermissionsResetArgs,
  toolPermissionsSetArgs,
} from './security-handler-args.ts'

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

function isError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && Object.hasOwn(result, 'error')
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

// What the hand-written `gh:*` handlers did: one `parseIpcArgs` call per argument, in order.
const zGhName = z.string().min(1).max(128)
const zPrNumber = z.number().int().positive()
const handWrittenPrRef = (owner: unknown, repo: unknown, number: unknown): unknown => ({
  owner: parseIpcArgs(zGhName, [owner]),
  repo: parseIpcArgs(zGhName, [repo]),
  number: parseIpcArgs(zPrNumber, [number]),
})

// Argument lists for `owner, repo, number[, path]`: each position failing on
// its own, several failing at once, too few, extra and wrapped.
const PR_REF_ARGUMENT_LISTS: unknown[][] = [
  [],
  ['octo'],
  ['octo', 'repo'],
  ['octo', 'repo', 7],
  ['', 'repo', 7],
  ['octo', '', 7],
  ['octo', 'repo', 0],
  ['octo', 'repo', 1.5],
  ['octo', 'repo', '7'],
  ['o'.repeat(129), 'repo', 7],
  [42, null, -1],
  ['octo', 'repo', 7, 'src/index.ts'],
  ['octo', 'repo', 7, ''],
  ['octo', 'repo', 7, 42],
  ['octo', 'repo', 7, 'src/index.ts', 'extra'],
  [['octo', 'repo', 7]],
  [null],
]

describe("{ errors: 'per-argument' } matches one parseIpcArgs call per argument", () => {
  const perArgument: PositionalArgsOptions = { errors: 'per-argument' }

  it('gh:pr-checks, gh:pr-details and the PR write actions (owner, repo, number)', () => {
    for (const rawArgs of PR_REF_ARGUMENT_LISTS) {
      assert.deepEqual(
        outcome(() => {
          const [owner, repo, number] = parsePositionalIpcArgs(ghPrRefArgs, rawArgs, perArgument)
          return { owner, repo, number }
        }),
        outcome(() => handWrittenPrRef(rawArgs[0], rawArgs[1], rawArgs[2])),
        JSON.stringify(rawArgs),
      )
    }
  })

  it('gh:pr-file-diff (owner, repo, number, path)', () => {
    const handWritten = (...[owner, repo, number, path]: unknown[]): unknown => ({
      ref: handWrittenPrRef(owner, repo, number),
      path: parseIpcArgs(zPathString, [path]),
    })
    for (const rawArgs of PR_REF_ARGUMENT_LISTS) {
      assert.deepEqual(
        outcome(() => {
          const [owner, repo, number, path] = parsePositionalIpcArgs(
            ghPrFileDiffArgs,
            rawArgs,
            perArgument,
          )
          return { ref: { owner, repo, number }, path }
        }),
        outcome(() => handWritten(...rawArgs)),
        JSON.stringify(rawArgs),
      )
    }
  })

  it('gh:create-pr-for-thread (projectId, threadId, request)', () => {
    const handWritten = (...[projectId, threadId, request]: unknown[]): unknown => [
      parseIpcArgs(zProjectId, [projectId]),
      parseIpcArgs(zThreadId, [threadId]),
      parseIpcArgs(zPrComposerCreateRequest, [request]),
    ]
    const request = { title: '  Add the thing ', draft: true }
    for (const rawArgs of [
      ...ARGUMENT_LISTS,
      [PROJECT, THREAD, request],
      [PROJECT, THREAD, { title: '' }],
      [PROJECT, THREAD, { title: 'ok', head: 'main' }],
      [42, THREAD, { title: '' }],
      [PROJECT, THREAD, request, 'extra'],
      [[PROJECT, THREAD, request]],
    ]) {
      assert.deepEqual(
        outcome(() => parsePositionalIpcArgs(ghCreatePrForThreadArgs, rawArgs, perArgument)),
        outcome(() => handWritten(...rawArgs)),
        JSON.stringify(rawArgs),
      )
    }
  })

  it('storage:set (key, value): the value passes through unparsed', () => {
    const zKey = zNonEmptyString.max(256)
    const value = { nested: [1, 2, 3] }
    const handWritten = (key: unknown, raw: unknown): unknown => [parseIpcArgs(zKey, [key]), raw]
    const args = z.tuple([zKey, z.unknown()])
    for (const rawArgs of [...ARGUMENT_LISTS, ['k', value], ['', value], ['k'.repeat(257)]]) {
      assert.deepEqual(
        outcome(() => parsePositionalIpcArgs(args, rawArgs, perArgument)),
        outcome(() => handWritten(rawArgs[0], rawArgs[1])),
        JSON.stringify(rawArgs),
      )
    }
    assert.equal(parsePositionalIpcArgs(args, ['k', value], perArgument)[1], value)
  })

  it('reports only the first failing argument, with no tuple index', () => {
    const tupleError = outcome(() => parsePositionalIpcArgs(ghPrRefArgs, [42, null, -1]))
    const perArgumentError = outcome(() =>
      parsePositionalIpcArgs(ghPrRefArgs, [42, null, -1], perArgument),
    )
    assert.notDeepEqual(perArgumentError, tupleError)
    assert.deepEqual(
      perArgumentError,
      outcome(() => parseIpcArgs(zGhName, [42])),
    )
  })

  it('accepts exactly the argument lists the tuple form accepts', () => {
    for (const rawArgs of PR_REF_ARGUMENT_LISTS) {
      const tuple = ghPrFileDiffArgs.safeParse(rawArgs.slice(0, 4))
      const each = outcome(() => parsePositionalIpcArgs(ghPrFileDiffArgs, rawArgs, perArgument))
      if (tuple.success) assert.deepEqual(each, { ok: tuple.data }, JSON.stringify(rawArgs))
      else assert.equal(isError(each), true, JSON.stringify(rawArgs))
    }
  })
})

describe('single-argument channels adopted in this round match parseIpcArgs(schema, [raw])', () => {
  // gh:resolve-pr-url, gh:pr-thread-relationships, gh:thread-pr-relationships,
  // machines:remove / machines:revoke and chat-gpt-plan:sign-in.
  const schemas: [string, z.ZodType][] = [
    ['url', z.url().max(2048)],
    ['pr ref', prRefSchema],
    ['thread id', z.string().min(1)],
    ['uuid', z.uuid()],
    ['optional account', z.string().min(1).max(256).optional()],
  ]
  const values: unknown[] = [
    undefined,
    null,
    '',
    42,
    'https://github.com/octo/repo/pull/7',
    'not a url',
    '0b6f2ac6-9c1c-4b65-8e47-7d0f3a5f1c11',
    { owner: 'octo', repo: 'repo', number: 7 },
    { owner: 'octo', repo: 'repo' },
    ['https://github.com/octo/repo/pull/7'],
  ]
  for (const [name, schema] of schemas) {
    it(name, () => {
      for (const raw of values) {
        for (const rawArgs of [[raw], [raw, 'extra']]) {
          assert.deepEqual(
            outcome(() => parsePositionalIpcArgs(z.tuple([schema]), rawArgs)[0]),
            outcome(() => parseIpcArgs(schema, [raw])),
            JSON.stringify(rawArgs),
          )
        }
      }
    })
  }
})

describe('environment-setup, tool-permissions and classifier channels match their hand-written parse', () => {
  const UUID = '0b6f2ac6-9c1c-4b65-8e47-7d0f3a5f1c11'
  const values: unknown[] = [
    undefined,
    null,
    '',
    42,
    true,
    false,
    'ollama',
    'Not-A-Key',
    'k'.repeat(53),
    'k'.repeat(54),
    UUID,
    [UUID],
    Array.from({ length: 65 }, () => UUID),
    { toolIds: ['mcp:a'], policy: 'allow' },
    { toolIds: ['mcp:a'], policy: 'sometimes' },
    { toolIds: [''] },
    { toolIds: ['mcp:a'] },
    { id: 'my-classifier' },
  ]

  // What each handler did before: `parseIpcArgs(schema, [raw])` with the schema
  // it spelled inline, which the adopted tuple must match argument for argument.
  const zClassifierId = z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .max(53)
  const zToolIds = z.array(z.string().min(1).max(8192)).max(2_000)
  const singleArgument: [string, z.ZodTuple<[z.ZodType], null>, z.ZodType][] = [
    ['environment-setup:undo', environmentSetupUndoArgs, z.uuid()],
    ['environment-setup:dismiss', environmentSetupDismissArgs, z.boolean()],
    [
      'tool-permissions:set',
      toolPermissionsSetArgs,
      z.object({
        toolIds: zToolIds,
        policy: z.enum(TOOL_PERMISSION_POLICIES),
      }),
    ],
    ['tool-permissions:reset', toolPermissionsResetArgs, z.object({ toolIds: zToolIds })],
    ['classifiers:save', classifierSaveArgs, classifierProfileSchema],
    ['classifiers:remove, classifiers:test, local-classifiers:*', classifierIdArgs, zClassifierId],
    [
      'classifiers:set-screening, classifiers:set-background',
      classifierIdOrNullArgs,
      zClassifierId.nullable(),
    ],
  ]
  for (const [name, adopted, handWrittenSchema] of singleArgument) {
    it(name, () => {
      for (const raw of values) {
        for (const rawArgs of [[raw], [raw, 'extra'], [[raw]]]) {
          assert.deepEqual(
            outcome(() => parsePositionalIpcArgs(adopted, rawArgs)[0]),
            outcome(() => parseIpcArgs(handWrittenSchema, [rawArgs[0]])),
            JSON.stringify(rawArgs),
          )
        }
      }
      assert.deepEqual(
        outcome(() => parsePositionalIpcArgs(adopted, [])[0]),
        outcome(() => parseIpcArgs(handWrittenSchema, [undefined])),
      )
    })
  }

  it('environment-setup:apply (reviewId, ids): parseIpcArgs(tuple, [a, b])', () => {
    const handWritten = z.tuple([z.uuid(), z.array(z.uuid()).max(64)])
    const lists: unknown[][] = [...ARGUMENT_LISTS]
    for (const a of values) for (const b of values) lists.push([a, b], [a, b, 'extra'])
    lists.push([[UUID, [UUID]]])
    for (const rawArgs of lists) {
      assert.deepEqual(
        outcome(() => parsePositionalIpcArgs(environmentSetupApplyArgs, rawArgs)),
        outcome(() => parseIpcArgs(handWritten, [rawArgs[0], rawArgs[1]])),
        JSON.stringify(rawArgs),
      )
    }
    assert.deepEqual(parsePositionalIpcArgs(environmentSetupApplyArgs, [UUID, [UUID]]), [
      UUID,
      [UUID],
    ])
  })
})

describe('senderPositionalIpcHandler', () => {
  const event = (name: string): { name: string; sender: string } => ({
    name,
    sender: `${name}-contents`,
  })
  const check = (e: { name: string }): void => {
    appOnly(e.name)
  }

  it('passes event.sender ahead of the parsed arguments, after the sender check and parse', () => {
    const listener = senderPositionalIpcHandler(check, z.tuple([zProjectId]), (sender, pid) => [
      sender,
      pid,
    ])
    assert.deepEqual(listener(event('app'), PROJECT, 'extra'), ['app-contents', PROJECT])
    assert.throws(() => listener(event('app'), 42), IpcValidationError)
  })

  it('rejects the sender before parsing or calling the handler', () => {
    let calls = 0
    const listener = senderPositionalIpcHandler(check, z.tuple([zProjectId]), () => ++calls)
    assert.throws(() => listener(event('webview'), 42), /did not come from the app window/)
    assert.throws(() => listener(event('webview'), PROJECT), /did not come from the app window/)
    assert.equal(calls, 0)
  })

  it('parses like positionalIpcHandler for every argument list', () => {
    const args = z.tuple([zProjectId, zThreadId])
    const withSender = senderPositionalIpcHandler(check, args, (_sender, ...parsed) => parsed)
    const plain = positionalIpcHandler(check, args, (...parsed) => parsed)
    for (const rawArgs of ARGUMENT_LISTS) {
      assert.deepEqual(
        outcome(() => withSender(event('app'), ...rawArgs)),
        outcome(() => plain(event('app'), ...rawArgs)),
        JSON.stringify(rawArgs),
      )
    }
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
