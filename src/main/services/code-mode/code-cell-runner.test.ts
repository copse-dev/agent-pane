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

  it('exits on its own when the link closes, even while a cell keeps its thread busy', async () => {
    const container = await CodeCellContainer.start(testSpec(), deps())
    const child = children.at(-1)
    assert.ok(child)
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('exit', (code, signal) => {
          resolve({ code, signal })
        })
      },
    )
    // The cell spins after its first await, so only the host's deadline or
    // the link closing can end it.
    const spinning = container.runCell(cell('await null\nwhile (true) {}'))
    await container.stop()
    assert.equal((await spinning).kind, 'failed')
    // Exited by itself: not the SIGKILL `stop` sends to a runner that does not.
    assert.deepEqual(await exited, { code: 0, signal: null })
  })
})
