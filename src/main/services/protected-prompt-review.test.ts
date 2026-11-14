import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  protectedPromptImageDataUrls,
  protectedPromptMessageMatches,
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
