import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isImageAttachment,
  parseKnowledgeAttachments,
  serializeKnowledgeAttachments,
  type KnowledgeAttachment,
} from './attachments.ts'

describe('knowledge attachments field', () => {
  const sample: KnowledgeAttachment[] = [
    { id: 'a1', name: 'screenshot.png', mimeType: 'image/png', size: 1234 },
    { id: 'a2', name: 'evals.jsonl', mimeType: 'application/x-jsonlines', size: 99 },
  ]

  it('round-trips through the serialized field value', () => {
    assert.deepEqual(parseKnowledgeAttachments(serializeKnowledgeAttachments(sample)), sample)
  })

  it('serializes to a single line (frontmatter scalars collapse newlines)', () => {
    assert.ok(!serializeKnowledgeAttachments(sample).includes('\n'))
  })

  it('degrades hand-edited or malformed values to no attachments', () => {
    assert.deepEqual(parseKnowledgeAttachments(undefined), [])
    assert.deepEqual(parseKnowledgeAttachments(''), [])
    assert.deepEqual(parseKnowledgeAttachments('not json'), [])
    assert.deepEqual(parseKnowledgeAttachments('{"id":"x"}'), [])
    assert.deepEqual(parseKnowledgeAttachments('[{"id":"x"}]'), [])
  })

  it('keeps valid entries and drops malformed ones', () => {
    const value = JSON.stringify([sample[0], { id: 'broken' }, sample[1]])
    assert.deepEqual(parseKnowledgeAttachments(value), sample)
  })

  it('drops unknown extra keys on parse', () => {
    const value = JSON.stringify([{ ...sample[0], extra: 'x' }])
    assert.deepEqual(parseKnowledgeAttachments(value), [sample[0]])
  })

  it('classifies images by mime type', () => {
    assert.ok(isImageAttachment({ mimeType: 'image/jpeg' }))
    assert.ok(!isImageAttachment({ mimeType: 'application/x-jsonlines' }))
  })
})
