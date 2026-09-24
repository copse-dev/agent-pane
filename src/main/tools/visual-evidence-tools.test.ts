import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { createBrowserCaptureHandle } from '../services/visual-evidence/capture-handle-store.ts'
import { presentVisualEvidenceTool } from './visual-evidence-tools.ts'

const THREAD_CONTEXT: ThreadExecutionContext = {
  projectId: 'project-evidence',
  threadId: 'thread-evidence',
  projectRoot: '/project',
  root: '/project',
  checkoutMode: 'shared',
  branch: 'main',
}

function capture(bytes: string, capturedAt: number, url: string): string {
  return createBrowserCaptureHandle(THREAD_CONTEXT, {
    source: { kind: 'browser', viewId: 'tab-1', title: 'Bug reproduction', url },
    capturedAt,
    width: 1280,
    height: 800,
    bytes: Buffer.from(bytes),
  }).id
}

describe('present_visual_evidence', () => {
  const signal = new AbortController().signal

  it('publishes a before/after copy without retaining handles or URL secrets', async () => {
    const before = capture(
      'before pixels',
      1_000,
      'https://user:secret@example.test/login?token=private#dialog',
    )
    const after = capture('after pixels', 2_000, 'https://example.test/login?token=other')

    const result = await runWithThreadExecutionContext(THREAD_CONTEXT, () =>
      presentVisualEvidenceTool.execute(
        {
          caption: 'The repaired dialog keeps its focus ring.',
          captures: [
            { captureHandle: before, label: undefined },
            { captureHandle: after, label: undefined },
          ],
        },
        signal,
      ),
    )

    assert.notEqual(typeof result, 'string')
    if (typeof result === 'string') return
    assert.match(result.result, /before\/after visual comparison/i)
    const evidence = result.visualEvidence?.[0]
    assert.ok(evidence)
    assert.equal(evidence.kind, 'comparison')
    assert.deepEqual(
      evidence.assets.map((asset) => asset.label),
      ['Before', 'After'],
    )
    assert.deepEqual(
      evidence.assets.map((asset) => asset.source.url),
      ['https://example.test/login', 'https://example.test/login'],
    )
    assert.deepEqual(
      evidence.assets.map((asset) => asset.dataUrl),
      [
        `data:image/png;base64,${Buffer.from('before pixels').toString('base64')}`,
        `data:image/png;base64,${Buffer.from('after pixels').toString('base64')}`,
      ],
    )
    assert.doesNotMatch(JSON.stringify(evidence), /capture_/)
    assert.doesNotMatch(JSON.stringify(evidence), /private|secret|token=/)
  })

  it('defaults one capture to a screenshot card', async () => {
    const handle = capture('pixels', 1_000, 'about:blank')
    const result = await runWithThreadExecutionContext(THREAD_CONTEXT, () =>
      presentVisualEvidenceTool.execute(
        {
          caption: 'The empty state is visible.',
          captures: [{ captureHandle: handle, label: undefined }],
        },
        signal,
      ),
    )
    assert.notEqual(typeof result, 'string')
    if (typeof result === 'string') return
    const evidence = result.visualEvidence?.[0]
    assert.ok(evidence)
    assert.equal(evidence.kind, 'screenshot')
    assert.equal(evidence.assets[0]?.label, 'Screenshot')
  })

  it('cannot resolve a handle from another thread', () => {
    const handle = capture('private pixels', 1_000, 'https://example.test/')
    assert.throws(
      () =>
        runWithThreadExecutionContext({ ...THREAD_CONTEXT, threadId: 'another-thread' }, () =>
          presentVisualEvidenceTool.execute(
            {
              caption: 'Should not publish.',
              captures: [{ captureHandle: handle, label: undefined }],
            },
            signal,
          ),
        ),
      /expired, unavailable, or belongs to another thread/,
    )
  })

  it('rejects duplicate handles at the schema boundary', () => {
    const handle = capture('same pixels', 1_000, 'https://example.test/')
    assert.throws(
      () =>
        presentVisualEvidenceTool.parameters.parse({
          caption: 'Duplicate proof.',
          captures: [{ captureHandle: handle }, { captureHandle: handle }],
        }),
      /Capture handles must be unique/,
    )
  })
})
