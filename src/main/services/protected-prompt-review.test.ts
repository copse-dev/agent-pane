import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  protectedPromptImageDataUrls,
  ProtectedPromptInterruptionDeadline,
  protectedPromptMessageMatches,
  ProtectedPromptReviewQueue,
  reviewedTranscriptAttachments,
  protectedPromptSubmissionIsUnchanged,
  protectedPromptStoredContext,
  withProtectedPromptText,
} from '../windows/protected-prompt-review.ts'
import type { LLMMessage } from '@shared/types'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'
import {
  buildTextWithAttachments,
  renderTextBlock,
} from '@copse/agent/build-text-with-attachments.ts'

test('protected prompt interruption waits only for its bounded draft handoff', async () => {
  const timeout = Promise.withResolvers<undefined>()
  const deadline = new ProtectedPromptInterruptionDeadline(5)
  let sends = 0
  deadline.request(
    () => {
      sends += 1
    },
    () => {
      timeout.resolve(undefined)
    },
  )
  deadline.request(
    () => {
      sends += 1
    },
    () => assert.fail('a duplicate request must not replace the first deadline'),
  )
  await timeout.promise
  assert.equal(sends, 1)
  assert.equal(deadline.isRequested, true)
})

test('protected prompt interruption fails closed when the isolated window cannot reply', () => {
  const deadline = new ProtectedPromptInterruptionDeadline()
  let timedOut = false
  deadline.request(
    () => {
      throw new Error('window closed')
    },
    () => {
      timedOut = true
    },
  )
  assert.equal(timedOut, true)
  deadline.finish()
})

test('protected prompt reviews queue per parent without blocking another parent', async () => {
  const queue = new ProtectedPromptReviewQueue()
  const events: string[] = []
  let releaseFirst = (): void => {}
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const first = queue.run(1, async () => {
    events.push('first:start')
    await firstGate
    events.push('first:end')
    return 'first'
  })
  const second = queue.run(1, async () => {
    events.push('second:start')
    events.push('second:end')
    return 'second'
  })
  const otherParent = queue.run(2, async () => {
    events.push('other:start')
    return 'other'
  })

  await otherParent
  assert.deepEqual(events, ['first:start', 'other:start'])
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.deepEqual(events, [
    'first:start',
    'other:start',
    'first:end',
    'second:start',
    'second:end',
  ])
})

test('an aborted queued protected review exits without opening or breaking serialization', async () => {
  const queue = new ProtectedPromptReviewQueue()
  const releaseFirst = Promise.withResolvers<undefined>()
  const firstOpened = Promise.withResolvers<undefined>()
  const events: string[] = []
  const first = queue.run(1, async () => {
    events.push('first:start')
    firstOpened.resolve(undefined)
    await releaseFirst.promise
    events.push('first:end')
    return 'first'
  })
  await firstOpened.promise

  const controller = new AbortController()
  const second = queue.run(
    1,
    async () => {
      events.push('second:opened')
      return 'second'
    },
    { signal: controller.signal, result: () => 'aborted' },
  )
  const third = queue.run(1, async () => {
    events.push('third:opened')
    return 'third'
  })

  controller.abort()
  assert.equal(await second, 'aborted')
  assert.deepEqual(events, ['first:start'])
  releaseFirst.resolve(undefined)
  assert.deepEqual(await Promise.all([first, third]), ['first', 'third'])
  assert.deepEqual(events, ['first:start', 'first:end', 'third:opened'])
})

test('protected prompt edits preserve image bytes while replacing renderer text', () => {
  const image = { type: 'image' as const, dataUrl: 'data:image/png;base64,AA==' }
  assert.deepEqual(
    withProtectedPromptText(
      [
        { type: 'text', text: 'renderer supplied' },
        image,
        { type: 'text', text: 'more renderer text' },
      ],
      'human reviewed',
    ),
    [{ type: 'text', text: 'human reviewed' }, image],
  )
})

test('protected prompt can send an image without adding unreviewed text', () => {
  const image = { type: 'image' as const, dataUrl: 'data:image/png;base64,AA==' }
  assert.deepEqual(withProtectedPromptText([image], ''), [image])
})

test('protected prompt preserves an optimistic display only when review text is unchanged', () => {
  const content = [
    { type: 'image' as const, dataUrl: 'data:image/png;base64,AA==' },
    { type: 'text' as const, text: 'expanded thread reference' },
  ]
  assert.equal(
    protectedPromptSubmissionIsUnchanged(content, { text: 'expanded thread reference' }),
    true,
  )
  assert.equal(protectedPromptSubmissionIsUnchanged(content, { text: 'reviewed edit' }), false)
})

test('protected prompt exposes every model-facing image for isolated review', () => {
  assert.deepEqual(
    protectedPromptImageDataUrls([
      { type: 'text', text: 'review me' },
      { type: 'image', dataUrl: 'data:image/png;base64,AA==' },
      { type: 'image', dataUrl: 'data:image/jpeg;base64,BB==' },
    ]),
    ['data:image/png;base64,AA==', 'data:image/jpeg;base64,BB=='],
  )
})

test('protected prompt accepts a display hint only for exact user content', () => {
  const image = 'data:image/png;base64,AA=='
  const attachment = { kind: 'file' as const, label: 'report.txt', content: 'exact bytes' }
  assert.equal(
    protectedPromptMessageMatches(
      { content: 'visible prompt', images: [image], attachments: [attachment] },
      { content: 'visible prompt', attachments: [attachment] },
      [{ type: 'image', dataUrl: image }],
    ),
    true,
  )
  assert.equal(
    protectedPromptMessageMatches(
      { content: 'visible prompt', images: [image], attachments: [attachment] },
      {
        content: 'visible prompt',
        attachments: [attachment],
      },
      [{ type: 'image', dataUrl: 'data:image/png;base64,forged' }],
    ),
    false,
  )
  assert.equal(
    protectedPromptMessageMatches(
      { content: 'visible prompt', images: [image], attachments: [attachment] },
      {
        content: 'visible prompt',
        attachments: [{ ...attachment, content: 'forged bytes' }],
      },
      [{ type: 'image', dataUrl: image }],
    ),
    false,
  )
  assert.equal(
    protectedPromptMessageMatches(
      {
        content: 'visible prompt',
        images: [image],
        attachments: [{ ...attachment, placement: 'inline' }],
      },
      { content: 'visible prompt', attachments: [attachment] },
      [{ type: 'image', dataUrl: image }],
    ),
    false,
  )
  assert.equal(
    protectedPromptMessageMatches(
      {
        content: 'visible prompt',
        images: [image],
        attachments: [{ ...attachment, projection: 'canonical-block' }],
      },
      { content: 'visible prompt', attachments: [attachment] },
      [{ type: 'image', dataUrl: image }],
    ),
    false,
  )
})

test('reviewed attachments receive provenance only for exact placeholder expansion', () => {
  const attachment = {
    kind: 'paste' as const,
    label: 'Notes',
    content: 'exact bytes',
    placement: 'inline' as const,
  }
  const block = renderTextBlock(attachment.label, attachment.content)
  assert.deepEqual(
    reviewedTranscriptAttachments(
      [{ ...attachment, projection: 'canonical-thread-label' }],
      'before \uFFFC after',
      `before \n\n${block}\n\n after`,
    ),
    [{ ...attachment, projection: 'canonical-block' }],
  )
  assert.deepEqual(
    reviewedTranscriptAttachments([{ ...attachment, projection: 'canonical-block' }], block, block),
    [attachment],
  )
})

test('reviewed attachment provenance stays literal when a token is ambiguous', () => {
  const attachment = {
    kind: 'thread' as const,
    label: '@',
    placement: 'inline' as const,
  }
  assert.deepEqual(reviewedTranscriptAttachments([attachment], '\uFFFC@', '@@@'), [attachment])
})

test('reviewed trailing shell provenance requires an exact full prompt reconstruction', () => {
  const attachment = {
    kind: 'shell' as const,
    label: 'Run · git rebase --continue · exit 0',
    content: 'Successfully rebased and updated refs/heads/topic.',
  }
  const display = 'Continue after the Git recovery command completed.'
  const provider = buildTextWithAttachments(
    display,
    [],
    [{ label: `Shell: ${attachment.label}`, content: attachment.content }],
  )

  assert.deepEqual(reviewedTranscriptAttachments([attachment], display, provider), [
    { ...attachment, projection: 'canonical-block' },
  ])
  assert.deepEqual(
    reviewedTranscriptAttachments([attachment], 'Misleading renderer summary.', provider),
    [attachment],
  )
})

test('reviewed provenance preserves a literal object replacement character in pasted bytes', () => {
  const thread = {
    kind: 'thread' as const,
    label: 'Thread context',
    placement: 'inline' as const,
  }
  const paste = {
    kind: 'paste' as const,
    label: 'Document excerpt',
    content: 'before \uFFFC after',
    placement: 'inline' as const,
  }
  const expandedComposerText = `@${thread.label} then \n\n${renderTextBlock(paste.label, paste.content)}`
  const providerText = buildTextWithAttachments(expandedComposerText, [], [], {
    threadRefs: [
      {
        title: thread.label,
        date: 'today',
        spinePath: '/workspace/project/thread/events.jsonl',
      },
    ],
  })

  assert.deepEqual(
    reviewedTranscriptAttachments([thread, paste], `\uFFFC then \uFFFC`, providerText),
    [
      { ...thread, projection: 'canonical-thread-label' },
      { ...paste, projection: 'canonical-block' },
    ],
  )
  assert.match(providerText, /before \uFFFC after/)
  assert.ok(providerText.startsWith(expandedComposerText))
})

test('protected prompt exposes the exact frozen stored inference context', () => {
  const history: LLMMessage[] = [{ role: 'user', content: 'persisted conversation' }]
  const plan: StoredThreadPlan = {
    meta: {
      planId: 'plan-1',
      threadId: 'thread-1',
      title: 'Frozen plan',
      status: 'approved',
      currentRevision: 1,
      createdAt: 1,
      updatedAt: 2,
    },
    body: 'Only this reviewed plan may reach inference.',
    contentHash: 'reviewed-hash',
    comments: [],
    approval: null,
    completion: null,
  }

  assert.deepEqual(protectedPromptStoredContext(history, plan), [
    { label: 'Existing model conversation', value: JSON.stringify(history, null, 2) },
    { label: 'Existing thread plan', value: JSON.stringify(plan, null, 2) },
  ])
  assert.deepEqual(protectedPromptStoredContext([], null), [])
})
