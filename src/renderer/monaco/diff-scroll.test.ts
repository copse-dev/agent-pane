import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type * as Monaco from 'monaco-editor'
import { revealFirstDiffChange, waitForDidUpdateDiff, waitForViewModelDiff } from './diff-scroll.ts'

describe('diff-scroll reveal readiness', () => {
  it('revealFirstDiffChange scrolls to the first getLineChanges entry', () => {
    const revealed: number[] = []
    const editor = {
      getLineChanges: () => [
        {
          originalStartLineNumber: 10,
          originalEndLineNumber: 10,
          modifiedStartLineNumber: 12,
          modifiedEndLineNumber: 12,
        },
      ],
      getModifiedEditor: () => ({
        revealLineInCenterIfOutsideViewport: (line: number): void => {
          revealed.push(line)
        },
      }),
      getOriginalEditor: () => ({
        revealLineInCenterIfOutsideViewport: (line: number): void => {
          revealed.push(line)
        },
      }),
    } as unknown as Monaco.editor.IStandaloneDiffEditor

    revealFirstDiffChange(editor)
    assert.deepEqual(revealed, [12, 10])
  })

  it('revealFirstDiffChange no-ops when line changes are not ready yet', () => {
    let modifiedCalls = 0
    const editor = {
      getLineChanges: () => null,
      getModifiedEditor: () => ({
        revealLineInCenterIfOutsideViewport: (): void => {
          modifiedCalls++
        },
      }),
      getOriginalEditor: () => ({
        revealLineInCenterIfOutsideViewport: (): void => {},
      }),
    } as unknown as Monaco.editor.IStandaloneDiffEditor

    revealFirstDiffChange(editor)
    assert.equal(modifiedCalls, 0)
  })

  it('waitForDidUpdateDiff resolves on the first update event', async () => {
    const listeners: Array<() => void> = []
    const editor = {
      onDidUpdateDiff: (cb: () => void) => {
        listeners.push(cb)
        return { dispose(): void {} }
      },
    } as unknown as Monaco.editor.IStandaloneDiffEditor

    const pending = waitForDidUpdateDiff(editor, 1_000)
    assert.equal(listeners.length, 1, 'should subscribe to onDidUpdateDiff')
    listeners[0]?.()
    await pending
  })

  it('waitForDidUpdateDiff resolves on timeout when no update fires', async () => {
    const editor = {
      onDidUpdateDiff: () => ({ dispose(): void {} }),
    } as unknown as Monaco.editor.IStandaloneDiffEditor

    const started = Date.now()
    await waitForDidUpdateDiff(editor, 20)
    assert.ok(Date.now() - started >= 15, 'should wait roughly until the timeout')
  })

  it('waitForViewModelDiff swallows waitForDiff rejection', async () => {
    const viewModel = {
      waitForDiff: async (): Promise<void> => {
        throw new Error('no diff result available')
      },
    } as unknown as Monaco.editor.IDiffEditorViewModel

    await waitForViewModelDiff(viewModel, 1_000)
  })

  it('waitForViewModelDiff times out when waitForDiff never settles', async () => {
    const viewModel = {
      waitForDiff: async (): Promise<void> =>
        new Promise(() => {
          /* never settles */
        }),
    } as unknown as Monaco.editor.IDiffEditorViewModel

    const started = Date.now()
    await waitForViewModelDiff(viewModel, 20)
    assert.ok(Date.now() - started >= 15, 'should resolve via timeout')
  })
})
