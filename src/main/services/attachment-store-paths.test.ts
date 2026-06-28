import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  workspaceId,
  attachmentsRootFor,
  threadAttachmentsDir,
  sanitizeSegment,
} from './attachment-store-paths.ts'

describe('workspaceId', () => {
  it('is stable for the same path and differs across paths', () => {
    assert.equal(workspaceId('/a/b'), workspaceId('/a/b'))
    assert.notEqual(workspaceId('/a/b/myCheckout1'), workspaceId('/a/c/myCheckout1'))
  })
})

describe('attachmentsRootFor', () => {
  it('lives under ~/.copse/workspaces/<id>/attachments', () => {
    const root = attachmentsRootFor('/work')
    assert.equal(root, join(homedir(), '.copse', 'workspaces', workspaceId('/work'), 'attachments'))
  })
})

describe('threadAttachmentsDir', () => {
  it('nests a sanitised thread segment under the attachments root', () => {
    const dir = threadAttachmentsDir('/work', 'thread-123')
    assert.equal(dir, join(attachmentsRootFor('/work'), 'thread-123'))
  })

  it('cannot escape the attachments root via a crafted thread id', () => {
    const dir = threadAttachmentsDir('/work', '../../etc')
    assert.ok(dir.startsWith(attachmentsRootFor('/work') + '/'))
  })
})

describe('sanitizeSegment', () => {
  it('keeps a plain basename', () => {
    assert.equal(sanitizeSegment('report.jsonl'), 'report.jsonl')
  })

  it('strips directories and unsafe characters', () => {
    assert.equal(sanitizeSegment('/etc/../passwd'), 'passwd')
    assert.equal(sanitizeSegment('a b/c:d.txt'), 'c_d.txt')
  })

  it('falls back when the result would be empty or a dot segment', () => {
    assert.equal(sanitizeSegment(''), 'attachment')
    assert.equal(sanitizeSegment('..'), 'attachment')
    assert.equal(sanitizeSegment('/'), 'attachment')
  })
})
