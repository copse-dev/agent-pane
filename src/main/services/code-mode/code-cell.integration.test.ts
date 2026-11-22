import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleCodeCellRunner } from '../../../../scripts/lib/thread-container-worker-bundle.mts'
import type { ThreadContainerEngine } from '../container-runtime/container-engine.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { engineCommand } from '../container-runtime/container-engine.ts'
import { listManagedRuntimes, runEngine } from '../container-runtime/thread-container.ts'
import {
  CodeCellContainer,
  DEFAULT_CODE_CELL_LIMITS,
  newCodeCellRuntimeId,
  type CellOutcome,
  type CellToolHandler,
} from './code-cell-container.ts'
import { buildCodeCellImage } from './code-cell-image.ts'

/**
 * Code cells in a real engine: the bundled runner in the built image, the
 * hardened container, the stdio link and a host tool handler.
 *
 * Opt-in, like the thread-container end-to-end test: it builds an image and
 * needs an engine. `COPSE_CODE_CELL_E2E=1` runs it on Docker,
 * `COPSE_CODE_CELL_E2E=apple` on Apple container. A sandbox that cannot reach
 * Docker Hub sets `COPSE_WORKER_BASE_IMAGE` to a mirror of the pinned base.
 */
const E2E = process.env['COPSE_CODE_CELL_E2E']
const ENGINE: ThreadContainerEngine | null =
  E2E === '1' ? 'docker' : E2E === 'apple' ? 'apple' : null
const IMAGE = 'copse-code-cell:e2e'

function valueOf(outcome: CellOutcome): string {
  assert.equal(outcome.kind, 'result', JSON.stringify(outcome))
  assert.equal(outcome.result.ok, true, JSON.stringify(outcome.result))
  return outcome.result.value
}

const files: Record<string, string> = {
  'src/a.ts': 'export const a = 1\n// TODO: a\n',
  'src/b.ts': 'export const b = 2\n',
  'src/c.ts': '// TODO: c\n// TODO: c again\n',
}

const fakeTools: CellToolHandler = (name, args) => {
  if (name === 'list_dir')
    return Promise.resolve({ ok: true, result: Object.keys(files).join('\n') })
  if (name === 'read_file') {
    const path = String(args['path'])
    const body = Object.hasOwn(files, path) ? files[path] : undefined
    return Promise.resolve(
      body === undefined
        ? { ok: false, error: `No such file: ${path}` }
        : { ok: true, result: body },
    )
  }
  return Promise.resolve({ ok: false, error: `tools.${name} is not available in a code cell.` })
}

/**
 * Runs inside a cell. The cell's `vm` context is not a boundary, so this
 * reaches the runner's own process through an outer-realm function and
 * reports what the container lets that process do.
 */
const CONTAINMENT_PROBE = `
const outer = (console.log.constructor as FunctionConstructor)('return globalThis')()
const proc = outer.process
const fs = proc.getBuiltinModule('fs')
const os = proc.getBuiltinModule('os')
const status = fs.readFileSync('/proc/self/status', 'utf8')
let rootWritable = true
try { fs.writeFileSync('/app/probe', 'x') } catch { rootWritable = false }
const network = await outer.fetch('https://example.com', { signal: outer.AbortSignal.timeout(5000) })
  .then(() => 'reached', (error: Error) => 'blocked: ' + String(error.cause ?? error.message))
return {
  uid: proc.getuid(),
  interfaces: Object.keys(os.networkInterfaces()).filter((name: string) => name !== 'lo'),
  rootWritable,
  noNewPrivs: /NoNewPrivs:\\s+(\\d)/.exec(status)?.[1],
  capEff: /CapEff:\\s+(\\w+)/.exec(status)?.[1],
  hostHome: fs.existsSync('/Users') || fs.existsSync('/home/user'),
  network,
}
`

describe('code cells in a real container', { skip: ENGINE === null }, () => {
  const engine: ThreadContainerEngine = ENGINE ?? 'docker'
  let dir = ''

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-code-cell-e2e-'))
    const runner = await bundleCodeCellRunner(join(dir, 'runner.cjs'))
    await buildCodeCellImage(engine, { runner, image: IMAGE })
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function start(): Promise<CodeCellContainer> {
    return await CodeCellContainer.start({
      engine,
      image: IMAGE,
      runtimeId: newCodeCellRuntimeId(),
      ...DEFAULT_CODE_CELL_LIMITS,
    })
  }

  function cell(code: string): Parameters<CodeCellContainer['runCell']>[0] {
    return { code, timeoutMs: 30_000, signal: new AbortController().signal, callTool: fakeTools }
  }

  it('runs cells that call host tools, keeps state between them, and is removed on stop', async () => {
    const container = await start()
    const name = container.spec.runtimeId
    try {
      const counted = valueOf(
        await container.runCell(
          cell(`
const paths = (await tools.list_dir({ path: 'src' })).split('\\n')
const todos: Record<string, number> = {}
for (const path of paths) {
  const text = await tools.read_file({ path })
  todos[path] = text.split('\\n').filter((line) => line.includes('TODO')).length
}
state.todos = todos
return todos
`),
        ),
      )
      assert.deepEqual(JSON.parse(counted), { 'src/a.ts': 1, 'src/b.ts': 0, 'src/c.ts': 2 })
      const total = valueOf(
        await container.runCell(
          cell(
            'return Object.values(state.todos as Record<string, number>).reduce((a, b) => a + b, 0)',
          ),
        ),
      )
      assert.equal(total, '3')
    } finally {
      await container.stop()
    }
    const left = await listManagedRuntimes(engine)
    assert.ok(!left.some((runtime) => runtime.runtimeId === name), 'the container is gone')
  })

  it('confines the runner: no network, read-only root, unprivileged, no host files', async () => {
    const container = await start()
    try {
      const report: unknown = JSON.parse(valueOf(await container.runCell(cell(CONTAINMENT_PROBE))))
      assert.ok(typeof report === 'object' && report !== null)
      const fields = Object.fromEntries(Object.entries(report))
      assert.equal(fields['uid'], 1001)
      assert.deepEqual(fields['interfaces'], [])
      assert.equal(fields['rootWritable'], false)
      assert.equal(fields['noNewPrivs'], '1')
      assert.equal(fields['capEff'], '0000000000000000')
      assert.equal(fields['hostHome'], false)
      assert.match(String(fields['network']), /^blocked/)
    } finally {
      await container.stop()
    }
  })

  // A runner whose only thread a spinning cell holds cannot even finish
  // sending the second request, so without the worker this test would wait
  // on it forever: hence the timeout.
  it(
    'exits by itself when the app dies mid-cell, even while the cell spins',
    { timeout: 60_000 },
    async (t) => {
      if (engine !== 'docker') {
        t.skip('Apple container has no `wait` to observe the exit with')
        return
      }
      let attached: ChildProcess | null = null
      const name = newCodeCellRuntimeId()
      const container = await CodeCellContainer.start(
        { engine, image: IMAGE, runtimeId: name, ...DEFAULT_CODE_CELL_LIMITS },
        {
          runEngine: (which, args) => runEngine(which, args),
          attach: (which, containerId) => {
            const child = spawn(
              engineCommand(which),
              ['start', '--attach', '--interactive', containerId],
              {
                stdio: ['pipe', 'pipe', 'pipe'],
              },
            )
            attached = child
            return child
          },
          // No teardown: the container must go on its own.
          teardown: () => Promise.resolve(),
        },
      )
      try {
        // The cell's second request is sent on the line before its loop, so
        // once the host has it the cell is certainly spinning.
        let spinning = (): void => {}
        const isSpinning = new Promise<void>((resolve) => {
          spinning = resolve
        })
        void container.runCell({
          code: "await tools.read_file({ path: 'a' })\nvoid tools.read_file({ path: 'b' }).catch(() => {})\nwhile (true) {}",
          timeoutMs: 60_000,
          signal: new AbortController().signal,
          callTool: (_name, args) => {
            if (args['path'] === 'b') spinning()
            return Promise.resolve({ ok: true, result: 'text' })
          },
        })
        await isSpinning
        // The app crashing takes the engine CLI it spawned with it; nothing is
        // closed gracefully.
        assert.ok(attached)
        ;(attached as ChildProcess).kill('SIGKILL')
        const started = Date.now()
        // `docker wait` returns once the container has exited (and `--rm`
        // removes it); one already gone reads as "No such container".
        await runEngine('docker', ['wait', `copse-${name}`], { timeoutMs: 20_000 }).catch(
          (error: unknown) => {
            if (!/No such container/i.test(String(error))) throw error
          },
        )
        assert.ok(Date.now() - started < 20_000)
        const left = await listManagedRuntimes(engine)
        assert.ok(!left.some((runtime) => runtime.runtimeId === name), 'the container is gone')
      } finally {
        await runEngine('docker', ['rm', '--force', `copse-${name}`]).catch(() => '')
        await container.stop()
      }
    },
  )

  it('records how long a cold start and a cell on a warm container take', async () => {
    const cold: number[] = []
    const warm: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now()
      const container = await start()
      cold.push(performance.now() - t0)
      try {
        const t1 = performance.now()
        valueOf(await container.runCell(cell("return await tools.read_file({ path: 'src/a.ts' })")))
        warm.push(performance.now() - t1)
      } finally {
        await container.stop()
      }
    }
    const median = (values: number[]): number => [...values].sort((a, b) => a - b)[1] ?? NaN
    const engineVersion = await runEngine(engine, ['--version']).catch(() => engine)
    console.log(
      `[code-cell latency] ${engineVersion}: cold start median ${median(cold).toFixed(0)} ms (${cold.map((ms) => ms.toFixed(0)).join(', ')}); first cell on a ready container median ${median(warm).toFixed(1)} ms (${warm.map((ms) => ms.toFixed(1)).join(', ')})`,
    )
    assert.ok(median(warm) < median(cold), 'a warm container answers faster than a cold start')
  })
})
