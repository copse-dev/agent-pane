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
import { CODE_CELL_TOOL_TARGET, type ToolCallResponse } from './code-cell-wire.ts'

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

  it('refuses a tool call made after its cell has finished', async () => {
    const { container } = await started()
    let handled = 0
    const callTool: CellToolHandler = () => {
      handled += 1
      return Promise.resolve({ ok: true, result: 'should not be reached' })
    }
    try {
      resultOf(
        await container.runCell(
          cell(
            "setTimeout(() => { tools.read_file({ path: 'x' }).then((r) => { state.late = r }, (e) => { state.late = e.message }) }, 20)\nreturn 'done'",
            { callTool },
          ),
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.match(
        valueOf(await container.runCell(cell('return state.late'))),
        /No cell is running/,
      )
      assert.equal(handled, 0)
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
    try {
      await assert.rejects(guest.open(CODE_CELL_TOOL_TARGET), /No cell is running/)
      const running = container.runCell(
        cell('await new Promise((resolve) => setTimeout(resolve, 300))\nreturn 1'),
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      // A hostile guest opens requests it never finishes.
      const held = await Promise.all(
        Array.from({ length: 16 }, () => guest.open(CODE_CELL_TOOL_TARGET)),
      )
      await assert.rejects(guest.open(CODE_CELL_TOOL_TARGET), /at most 16 tool calls in flight/)
      for (const stream of held) stream.destroy()
      await new Promise((resolve) => setTimeout(resolve, 20))
      const again = await guest.open(CODE_CELL_TOOL_TARGET)
      again.destroy()
      assert.equal(valueOf(await running), '1')
    } finally {
      await container.stop()
    }
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
    let exitCode: number | null = null
    const tornDown: string[] = []
    const deps: CodeCellContainerDependencies = {
      runEngine: () => Promise.resolve(''),
      attach: () => {
        setImmediate(() => {
          stderr.write('node: cannot find /app/runner.cjs\n')
          setImmediate(() => {
            exitCode = 1
            events.emit('exit')
          })
        })
        return {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr,
          get exitCode(): number | null {
            return exitCode
          },
          once: (event, listener): unknown => events.once(event, listener),
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
