import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  persistAttachment,
  sweepThreadAttachments,
  sweepWorkspaceAttachments,
  MAX_ATTACHMENT_BYTES,
} from './attachment-store.ts'
import { attachmentsRootFor, threadAttachmentsDir } from './attachment-store-paths.ts'
import { getAttachmentsRoot } from './workspace.ts'

const WS = '/some/workspace/checkout'
const THREAD = '11111111-1111-4111-8111-111111111111'
let fakeHome: string
let prevHome: string | undefined

describe('attachment-store', () => {
  before(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'copse-home-'))
    prevHome = process.env.HOME
    process.env.HOME = fakeHome
  })

  after(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('writes content under the workspace attachments root and registers it as readable', async () => {
    const { path, bytes } = await persistAttachment(WS, THREAD, 'report.jsonl', 'hello world')
    assert.equal(bytes, Buffer.byteLength('hello world'))
    assert.ok(path.startsWith(threadAttachmentsDir(WS, THREAD) + '/'))
    assert.equal(readFileSync(path, 'utf-8'), 'hello world')
    assert.equal(getAttachmentsRoot(), attachmentsRootFor(WS))
  })

  it('sanitises the attachment name into a single safe segment', async () => {
    const { path } = await persistAttachment(WS, THREAD, '../../etc/passwd', 'x')
    assert.ok(path.startsWith(threadAttachmentsDir(WS, THREAD) + '/'))
    assert.ok(path.endsWith('-passwd'))
  })

  it('rejects content above the size ceiling', async () => {
    const huge = 'a'.repeat(MAX_ATTACHMENT_BYTES + 1)
    await assert.rejects(() => persistAttachment(WS, THREAD, 'big.txt', huge), /too large/)
  })

  it('sweepThreadAttachments removes only that thread', async () => {
    const other = '22222222-2222-4222-8222-222222222222'
    const a = await persistAttachment(WS, THREAD, 'a.txt', 'a')
    const b = await persistAttachment(WS, other, 'b.txt', 'b')
    await sweepThreadAttachments(WS, THREAD)
    assert.equal(existsSync(a.path), false)
    assert.equal(existsSync(b.path), true)
  })

  it('sweepWorkspaceAttachments clears the whole workspace root', async () => {
    const a = await persistAttachment(WS, THREAD, 'a.txt', 'a')
    await sweepWorkspaceAttachments(WS)
    assert.equal(existsSync(a.path), false)
  })
})
