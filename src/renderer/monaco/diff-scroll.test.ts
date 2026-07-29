import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { revealFirstDiffChange, waitForDidUpdateDiff, waitForViewModelDiff } from './diff-scroll.ts'

describe('diff-scroll reveal readiness', () => {
  it('revealFirstDiffChange scrolls to the first getLineChanges entry', () => {
    const revealed: number[] = []
    const editor = {
      getLineChanges: (): ReturnType<
        Parameters<typeof revealFirstDiffChange>[0]['getLineChanges']
      > => [
        {
          originalStartLineNumber: 10,
          originalEndLineNumber: 10,
          modifiedStartLineNumber: 12,
          modifiedEndLineNumber: 12,
        },
      ],
      getModifiedEditor: (): ReturnType<
        Parameters<typeof revealFirstDiffChange>[0]['getModifiedEditor']
      > => ({
        revealLineInCenterIfOutsideViewport: (line: number): void => {
          revealed.push(line)
        },
      }),
      getOriginalEditor: (): ReturnType<
        Parameters<typeof revealFirstDiffChange>[0]['getOriginalEditor']
      > => ({
        revealLineInCenterIfOutsideViewport: (line: number): void => {
          revealed.push(line)
        },
      }),
    } satisfies Parameters<typeof revealFirstDiffChange>[0]

    revealFirstDiffChange(editor)
    assert.deepEqual(revealed, [12, 10])
  })

  it('revealFirstDiffChange no-ops when line changes are not ready yet', () => {
    let modifiedCalls = 0
    const editor = {
      getLineChanges: (): null => null,
      getModifiedEditor: (): ReturnType<
        Parameters<typeof revealFirstDiffChange>[0]['getModifiedEditor']
      > => ({
        revealLineInCenterIfOutsideViewport: (): void => {
          modifiedCalls++
        },
      }),
      getOriginalEditor: (): ReturnType<
        Parameters<typeof revealFirstDiffChange>[0]['getOriginalEditor']
      > => ({
        revealLineInCenterIfOutsideViewport: (): void => {},
      }),
    } satisfies Parameters<typeof revealFirstDiffChange>[0]

    revealFirstDiffChange(editor)
    assert.equal(modifiedCalls, 0)
  })

  it('waitForDidUpdateDiff resolves on the first update event', async () => {
    const listeners: Array<() => void> = []
    const editor = {
      onDidUpdateDiff: (cb: () => void): { dispose(): void } => {
        listeners.push(cb)
        return { dispose(): void {} }
      },
    } satisfies Parameters<typeof waitForDidUpdateDiff>[0]

    const pending = waitForDidUpdateDiff(editor, 1_000)
    assert.equal(listeners.length, 1, 'should subscribe to onDidUpdateDiff')
    listeners[0]?.()
    await pending
  })

  it('waitForDidUpdateDiff resolves on timeout when no update fires', async () => {
    const editor = {
      onDidUpdateDiff: (): { dispose(): void } => ({ dispose(): void {} }),
    } satisfies Parameters<typeof waitForDidUpdateDiff>[0]

    const started = Date.now()
    await waitForDidUpdateDiff(editor, 20)
    assert.ok(Date.now() - started >= 15, 'should wait roughly until the timeout')
  })

  it('waitForViewModelDiff swallows waitForDiff rejection', async () => {
    const viewModel = {
      waitForDiff: async (): Promise<void> => {
        throw new Error('no diff result available')
      },
    } satisfies Parameters<typeof waitForViewModelDiff>[0]

    await waitForViewModelDiff(viewModel, 1_000)
  })

  it('waitForViewModelDiff times out when waitForDiff never settles', async () => {
    const viewModel = {
      waitForDiff: async (): Promise<void> =>
        new Promise(() => {
          /* never settles */
        }),
    } satisfies Parameters<typeof waitForViewModelDiff>[0]

    const started = Date.now()
    await waitForViewModelDiff(viewModel, 20)
    assert.ok(Date.now() - started >= 15, 'should resolve via timeout')
  })
})
