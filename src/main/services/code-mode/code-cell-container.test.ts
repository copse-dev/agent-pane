import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import {
  appleCodeCellConfigShortfall,
  codeCellCreateArgs,
  CodeCellContainer,
  type CellOutcome,
  type CellToolHandler,
  type CodeCellContainerDependencies,
} from './code-cell-container.ts'
import { inProcessEngine, testSpec } from './code-cell-harness.test-support.ts'
import { encodeFrame, FRAME } from '../container-runtime/egress-link.ts'
import {
  CODE_CELL_TOOL_TARGET,
  decodeLine,
  encodeLine,
  readMessage,
  toolCallResponseSchema,
  type ToolCallResponse,
} from './code-cell-wire.ts'

const noTools: CellToolHandler = () =>
  Promise.resolve({ ok: false, error: 'no tools in this test' })

function cell(
  code: string,
  options: { timeoutMs?: number; signal?: AbortSignal; callTool?: CellToolHandler } = {},
): Parameters<CodeCellContainer['runCell']>[0] {
  return {
    code,
    timeoutMs: options.timeoutMs ?? 5_000,
    signal: options.signal ?? new AbortController().signal,
    callTool: options.callTool ?? noTools,
  }
}

function resultOf(outcome: CellOutcome): Extract<CellOutcome, { kind: 'result' }>['result'] {
  assert.equal(outcome.kind, 'result', JSON.stringify(outcome))
  return outcome.result
}

/** The value a cell returned, failing the test when the cell threw. */
function valueOf(outcome: CellOutcome): string {
  const result = resultOf(outcome)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.value
}

/** What a cell threw, failing the test when it returned. */
function errorOf(outcome: CellOutcome): string {
  const result = resultOf(outcome)
  assert.equal(result.ok, false, JSON.stringify(result))
  return result.error
}

const NO_CELL_RUNNING_TEXT =
  'No cell is running: tools can only be called while the cell that asks is running.'

/**
 * A tool handler that holds every call until released, so a test can act
 * while a cell is known to be running, without sleeping.
 */
function heldTool(): {
  callTool: CellToolHandler
  entered: Promise<void>
  enteredTwice: Promise<void>
  release: () => void
  readonly calls: number
} {
  let calls = 0
  let enter = (): void => {}
  let enterTwice = (): void => {}
  let open = (): void => {}
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const enteredTwice = new Promise<void>((resolve) => {
    enterTwice = resolve
  })
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  return {
    callTool: async (): Promise<ToolCallResponse> => {
      calls += 1
      if (calls === 1) enter()
      if (calls === 2) enterTwice()
      await gate
      return { ok: true, result: 'held' }
    },
    entered,
    enteredTwice,
    release: (): void => {
      open()
    },
    get calls(): number {
      return calls
    },
  }
}

async function started(): Promise<{
  container: CodeCellContainer
  engine: ReturnType<typeof inProcessEngine>
}> {
  const engine = inProcessEngine()
  const container = await CodeCellContainer.start(testSpec(), engine.deps)
  return { container, engine }
}

describe('CodeCellContainer with the real guest', () => {
  it('runs a TypeScript cell and returns its value and console output', async () => {
    const { container } = await started()
    try {
      const result = resultOf(
        await container.runCell(
          cell("const n: number = 2\nconsole.log('hi', { a: 1 })\nreturn n + 3"),
        ),
      )
      assert.deepEqual(result, {
        id: 1,
        ok: true,
        value: '5',
        logs: 'hi { a: 1 }\n',
        truncated: false,
      })
    } finally {
      await container.stop()
    }
  })

  it('keeps state between cells, and let/const stay local to their cell', async () => {
    const { container } = await started()
    try {
      resultOf(
        await container.runCell(
          cell("state.count = 1\nglobalThis.seen = 'yes'\nconst local = 3\nreturn 'set'"),
        ),
      )
      assert.equal(
        valueOf(
          await container.runCell(cell("return [state.count, seen, typeof local].join(',')")),
        ),
        '1,yes,undefined',
      )
    } finally {
      await container.stop()
    }
  })

  it('routes tool calls to the handler, and a refused call throws inside the cell', async () => {
    const { container } = await started()
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const callTool: CellToolHandler = (name, args): Promise<ToolCallResponse> => {
      calls.push({ name, args })
      return Promise.resolve(
        name === 'read_file'
          ? { ok: true, result: `contents of ${String(args['path'])}` }
          : { ok: false, error: `tools.${name} is not available in a code cell.` },
      )
    }
    try {
      const value = valueOf(
        await container.runCell(
          cell(
            [
              "const a = await tools.read_file({ path: 'src/a.ts' })",
              'let b = ""',
              "try { await tools.run_shell({ command: 'ls' }) } catch (e) { b = (e as Error).message }",
              "return a + ' | ' + b",
            ].join('\n'),
            { callTool },
          ),
        ),
      )
      assert.equal(value, 'contents of src/a.ts | tools.run_shell is not available in a code cell.')
      assert.deepEqual(calls, [
        { name: 'read_file', args: { path: 'src/a.ts' } },
        { name: 'run_shell', args: { command: 'ls' } },
      ])
    } finally {
      await container.stop()
    }
  })

  it('refuses a tool request that names a cell other than the running one', async () => {
    const { container, engine } = await started()
    const held = heldTool()
    try {
      assert.equal(valueOf(await container.runCell(cell('return 1'))), '1')
      const running = container.runCell(
        cell("await tools.read_file({ path: 'hold' })\nreturn 2", { callTool: held.callTool }),
      )
      await held.entered
      // Cell 2 is running; a request stamped with cell 1 is refused.
      const stream = await engine.guestLink().open(CODE_CELL_TOOL_TARGET)
      stream.end(encodeLine({ cell: 1, name: 'read_file', args: { path: 'x' } }))
      const reply = decodeLine((await readMessage(stream)).trim(), toolCallResponseSchema)
      assert.deepEqual(reply, { ok: false, error: NO_CELL_RUNNING_TEXT })
      held.release()
      assert.equal(valueOf(await running), '2')
      assert.equal(held.calls, 1, 'only the running cell reached the handler')
    } finally {
      await container.stop()
    }
  })

  it("reports a thrown error with the cell's own stack frames", async () => {
    const { container } = await started()
    try {
      const error = errorOf(
        await container.runCell(cell("function f(): never { throw new Error('boom') }\nf()")),
      )
      assert.match(error, /^Error: boom/)
      assert.match(error, /cell-1\.ts:1/)
      assert.doesNotMatch(error, /node:vm|code-cell-guest/)
    } finally {
      await container.stop()
    }
  })

  it('reports a syntax error without running anything', async () => {
    const { container } = await started()
    try {
      assert.ok(errorOf(await container.runCell(cell('return ('))).length > 0)
    } finally {
      await container.stop()
    }
  })

  it('interrupts a synchronous infinite loop and keeps the container', async () => {
    const { container } = await started()
    try {
      assert.match(
        errorOf(await container.runCell(cell('while (true) {}', { timeoutMs: 100 }))),
        /timed out/,
      )
      assert.equal(container.alive, true)
    } finally {
      await container.stop()
    }
  })

  it('times out a cell that never settles, and the container is then unusable', async () => {
    const { container } = await started()
    try {
      const outcome = await container.runCell(
        cell('await new Promise(() => {})', { timeoutMs: 50 }),
      )
      assert.deepEqual(outcome, { kind: 'timeout' })
      assert.equal(container.alive, false)
      const next = await container.runCell(cell('return 1'))
      assert.equal(next.kind, 'failed')
    } finally {
      await container.stop()
    }
  })

  it("cancels a cell when the turn's signal aborts, and aborts its tool call", async () => {
    const { container } = await started()
    const controller = new AbortController()
    const toolSignals: AbortSignal[] = []
    const callTool: CellToolHandler = (_name, _args, signal) => {
      toolSignals.push(signal)
      controller.abort()
      return new Promise(() => {})
    }
    try {
      const outcome = await container.runCell(
        cell("await tools.read_file({ path: 'x' })", { signal: controller.signal, callTool }),
      )
      assert.deepEqual(outcome, { kind: 'aborted' })
      assert.equal(container.alive, false)
      assert.deepEqual(
        toolSignals.map((signal) => signal.aborted),
        [true],
      )
    } finally {
      await container.stop()
    }
  })

  it('refuses tool streams between cells and past the in-flight limit', async () => {
    const { container, engine } = await started()
    const guest = engine.guestLink()
    const held = heldTool()
    try {
      await assert.rejects(guest.open(CODE_CELL_TOOL_TARGET), /No cell is running/)
      const running = container.runCell(
        cell("await tools.read_file({ path: 'hold' })\nreturn 1", { callTool: held.callTool }),
      )
      await held.entered
      // One stream is the cell's own held call; a hostile guest opens the rest
      // and never finishes them.
      const extra = await Promise.all(
        Array.from({ length: 15 }, () => guest.open(CODE_CELL_TOOL_TARGET)),
      )
      await assert.rejects(guest.open(CODE_CELL_TOOL_TARGET), /at most 16 tool calls in flight/)
      for (const stream of extra) stream.destroy()
      let reopened: Awaited<ReturnType<typeof guest.open>> | null = null
      for (let attempt = 0; attempt < 50 && reopened === null; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve))
        reopened = await guest.open(CODE_CELL_TOOL_TARGET).catch(() => null)
      }
      assert.ok(reopened, 'a slot frees once a stream closes')
      reopened.destroy()
      held.release()
      assert.equal(valueOf(await running), '1')
    } finally {
      await container.stop()
    }
  })

  it('survives a guest that resets its tool stream while the host is answering', async () => {
    const { container, engine } = await started()
    const held = heldTool()
    const uncaught: unknown[] = []
    const record = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', record)
    try {
      const running = container.runCell(
        cell("await tools.read_file({ path: 'hold' })\nreturn 1", { callTool: held.callTool }),
      )
      await held.entered
      const stream = await engine.guestLink().open(CODE_CELL_TOOL_TARGET)
      stream.end(encodeLine({ cell: 1, name: 'read_file', args: { path: 'hold' } }))
      await held.enteredTwice
      // The guest's own end reports the reset too; only the host's matters here.
      stream.on('error', () => {})
      stream.destroy(new Error('reset by a hostile guest'))
      held.release()
      assert.equal(valueOf(await running), '1')
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(uncaught, [])
    } finally {
      process.off('uncaughtException', record)
      await container.stop()
    }
  })

  it('stops answering a guest that broke its control stream, without crashing', async () => {
    const { container, engine } = await started()
    const uncaught: unknown[] = []
    const record = (error: unknown): void => {
      uncaught.push(error)
    }
    process.on('uncaughtException', record)
    try {
      // The control stream is the guest's first stream (id 1).
      engine.sendRaw(encodeFrame(1, FRAME.DATA, 'not a control message\n'))
      engine.sendRaw(encodeFrame(999, FRAME.OPEN, CODE_CELL_TOOL_TARGET))
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
      assert.equal(container.alive, false)
      assert.deepEqual(uncaught, [])
    } finally {
      process.off('uncaughtException', record)
      await container.stop()
    }
  })

  it('stops and removes a container whose guest floods the link', async () => {
    const { container, engine } = await started()
    // Twenty-one thousand PINGs in one write: each asks the host for a PONG.
    engine.sendRaw(Buffer.concat(Array.from({ length: 21_000 }, () => encodeFrame(0, FRAME.PING))))
    for (let i = 0; i < 20 && engine.tornDown.length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(container.alive, false)
    assert.deepEqual(engine.tornDown, ['cell-test-1'])
    const outcome = await container.runCell(cell('return 1'))
    assert.equal(outcome.kind, 'failed')
  })

  it('refuses any stream but the two code-cell targets', async () => {
    const { container, engine } = await started()
    try {
      await assert.rejects(engine.guestLink().open('example.com:443'), /DENY/)
    } finally {
      await container.stop()
    }
  })

  it('stop removes the container once and leaves it unusable', async () => {
    const { container, engine } = await started()
    await Promise.all([container.stop(), container.stop()])
    assert.deepEqual(engine.tornDown, ['cell-test-1'])
    assert.equal(container.alive, false)
    assert.deepEqual(engine.engineCalls[0], codeCellCreateArgs(testSpec()))
  })

  it('fails to start, with the container log, when the runner exits before it is ready', async () => {
    const events = new EventEmitter()
    const stderr = new PassThrough()
    const tornDown: string[] = []
    const deps: CodeCellContainerDependencies = {
      runEngine: () => Promise.resolve(''),
      attach: () => {
        setImmediate(() => {
          stderr.write('node: cannot find /app/runner.cjs\n')
          setImmediate(() => {
            events.emit('exit')
          })
        })
        return {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr,
          once: (event, listener): unknown => events.once(event, listener),
          on: (event, listener): unknown => events.on(event, listener),
          kill: (): boolean => true,
        }
      },
      teardown: (runtimeId) => {
        tornDown.push(runtimeId)
        return Promise.resolve()
      },
    }
    await assert.rejects(
      CodeCellContainer.start(testSpec(), deps),
      /container exited[\s\S]*cannot find \/app\/runner\.cjs/,
    )
    assert.deepEqual(tornDown, ['cell-test-1'])
  })
})

describe('codeCellCreateArgs', () => {
  it('creates a Docker container with no network, mounts or capabilities', () => {
    const args = codeCellCreateArgs(testSpec())
    for (const flag of [
      '--rm',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--network=none',
      '--user=1001:1001',
      '--pids-limit=64',
      '--memory=512m',
      '--memory-swap=512m',
      '--log-driver=none',
      '--cpus=1',
      '--init',
    ]) {
      assert.ok(args.includes(flag), `${flag} is set`)
    }
    assert.ok(!args.some((arg) => /^(-v|--volume|--mount|--env|-e|--privileged)/.test(arg)))
    assert.equal(args.at(-1), 'copse-code-cell:test')
    assert.ok(args.includes('dev.copse.role=code-cell'))
  })

  it('creates the same guest under Apple container in its own spelling', () => {
    const args = codeCellCreateArgs(testSpec({ engine: 'apple' }))
    const pairs = new Map<string, string>()
    for (let i = 0; i < args.length - 1; i += 1) pairs.set(args[i] ?? '', args[i + 1] ?? '')
    assert.equal(pairs.get('--network'), 'none')
    assert.equal(pairs.get('--cap-drop'), 'ALL')
    assert.equal(pairs.get('--ulimit'), 'nproc=64:64')
    assert.equal(pairs.get('--user'), '1001:1001')
    assert.ok(args.includes('--read-only'))
    assert.ok(!args.includes('--rm'))
    assert.ok(!args.some((arg) => /^(-v|--volume|--mount|--env|-e)$/.test(arg)))
  })
})

function appleInspect(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      configuration: {
        capAdd: [],
        capDrop: ['ALL'],
        readOnly: true,
        networks: [],
        useInit: true,
        ssh: false,
        virtualization: false,
        publishedPorts: [],
        publishedSockets: [],
        labels: {
          'dev.copse.managed': '1',
          'dev.copse.runtime': 'cell-test-1',
          'dev.copse.role': 'code-cell',
        },
        resources: { cpus: 1, memoryInBytes: 512 * 1024 * 1024 },
        initProcess: {
          user: { raw: { userString: '1001:1001' } },
          rlimits: [{ limit: 'RLIMIT_NPROC', soft: 64, hard: 64 }],
        },
        mounts: [
          {
            destination: '/tmp',
            source: 'tmpfs',
            options: ['rw', 'noexec', 'nosuid', 'nodev'],
            type: { tmpfs: {} },
          },
        ],
        ...overrides,
      },
      status: { state: 'stopped' },
    },
  ])
}

describe('appleCodeCellConfigShortfall', () => {
  const spec = testSpec({ engine: 'apple' })

  it('accepts the configuration it asked for', () => {
    assert.equal(appleCodeCellConfigShortfall(spec, appleInspect()), null)
  })

  it('refuses a container that is missing any hardening', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ networks: [{ network: 'default' }] }, /attached to a network/],
      [{ readOnly: false }, /writable/],
      [{ capDrop: [] }, /not dropped/],
      [{ ssh: true }, /SSH agent/],
      [
        {
          mounts: [
            {
              destination: '/tmp',
              source: 'tmpfs',
              options: ['rw', 'nosuid', 'nodev'],
              type: { tmpfs: {} },
            },
            { destination: '/home', source: '/Users/me', options: ['rw'], type: { virtiofs: {} } },
          ],
        },
        /unexpected mount at \/home/,
      ],
      [{ mounts: [] }, /\/tmp scratch mount is missing/],
      [{ initProcess: { user: { raw: { userString: '0:0' } }, rlimits: [] } }, /runs as 0:0/],
    ]
    for (const [override, message] of cases) {
      assert.match(appleCodeCellConfigShortfall(spec, appleInspect(override)) ?? '', message)
    }
    assert.match(appleCodeCellConfigShortfall(spec, 'not json') ?? '', /did not describe/)
  })
})
