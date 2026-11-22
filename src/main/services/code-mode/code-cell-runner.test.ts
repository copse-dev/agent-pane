import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleCodeCellRunner } from '../../../../scripts/lib/thread-container-worker-bundle.mts'
import {
  CodeCellContainer,
  type AttachedProcess,
  type CellOutcome,
  type CellToolHandler,
  type CodeCellContainerDependencies,
} from './code-cell-container.ts'
import { testSpec } from './code-cell-harness.test-support.ts'

/**
 * The shipped runner bundle, worker thread included, as a plain child process
 * under the real host container class: everything a container run has except
 * the engine and its confinement (which `code-cell.integration.test.ts` covers).
 */
describe('the code-cell runner bundle', () => {
  let dir = ''
  let runner = ''
  const children: ChildProcess[] = []

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-code-cell-runner-'))
    runner = await bundleCodeCellRunner(join(dir, 'runner.cjs'))
  })

  after(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  })

  function deps(): CodeCellContainerDependencies {
    return {
      runEngine: (): Promise<string> => Promise.resolve(''),
      attach: (): AttachedProcess => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', runner], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        children.push(child)
        return child
      },
      teardown: (): Promise<void> => Promise.resolve(),
    }
  }

  const tools: CellToolHandler = (name, args) =>
    Promise.resolve(
      name === 'read_file'
        ? { ok: true, result: `contents of ${String(args['path'])}` }
        : { ok: false, error: `tools.${name} is not available in a code cell.` },
    )

  function cell(code: string): Parameters<CodeCellContainer['runCell']>[0] {
    return { code, timeoutMs: 10_000, signal: new AbortController().signal, callTool: tools }
  }

  function valueOf(outcome: CellOutcome): string {
    assert.equal(outcome.kind, 'result', JSON.stringify(outcome))
    assert.equal(outcome.result.ok, true, JSON.stringify(outcome.result))
    return outcome.result.value
  }

  it('runs cells on its worker, calling host tools and keeping state', async () => {
    const container = await CodeCellContainer.start(testSpec(), deps())
    try {
      assert.equal(
        valueOf(
          await container.runCell(
            cell("state.text = await tools.read_file({ path: 'a.ts' })\nreturn state.text"),
          ),
        ),
        'contents of a.ts',
      )
      assert.equal(valueOf(await container.runCell(cell('return state.text.length'))), '16')
    } finally {
      await container.stop()
    }
  })

  /**
   * Starts a container whose runner reports, on its stderr, the moment a cell
   * thread starts to spin. The cell writes the mark to fd 2 synchronously
   * through its own process (the `vm` context is no boundary), so the mark is
   * out before the loop whichever thread runs it.
   */
  async function startWatched(): Promise<{
    container: CodeCellContainer
    spinning: Promise<void>
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  }> {
    const container = await CodeCellContainer.start(testSpec(), deps())
    const child = children.at(-1)
    assert.ok(child?.stderr)
    const { stderr } = child
    const spinning = new Promise<void>((resolve) => {
      let seen = ''
      stderr.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8')
        if (seen.includes(SPIN_MARK)) resolve()
      })
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('exit', (code, signal) => {
          resolve({ code, signal })
        })
      },
    )
    return { container, spinning, exited }
  }

  const SPIN_MARK = '[test] cell thread spinning'
  const SPIN = `;(console.log.constructor as FunctionConstructor)('return globalThis')().process.getBuiltinModule('fs').writeSync(2, '${SPIN_MARK}\\n')\nfor (;;) {}`

  // Without the worker, the spinning cell holds the runner's only thread: it
  // never sees the link close, and `stop` ends it with SIGKILL.
  it('exits on its own when the link closes while a cell spins', async () => {
    const { container, spinning, exited } = await startWatched()
    const outcome = container.runCell(cell(`await null\n${SPIN}`))
    await spinning
    await container.stop()
    assert.equal((await outcome).kind, 'failed')
    assert.deepEqual(await exited, { code: 0, signal: null })
  })

  it('exits on its own when the link closes while a timer an earlier cell left spins', async () => {
    const { container, spinning, exited } = await startWatched()
    assert.equal(
      valueOf(await container.runCell(cell(`setTimeout(() => {\n${SPIN}\n}, 0)\nreturn 1`))),
      '1',
    )
    await spinning
    await container.stop()
    assert.deepEqual(await exited, { code: 0, signal: null })
  })
})
