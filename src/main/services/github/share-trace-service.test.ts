import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { Thread } from '@shared/types'
import { setShareTracePublisherForTest, shareThreadTrace } from './share-trace-service.ts'

function sampleThread(): Thread {
  return {
    id: 'tid-share-1',
    title: 'Share me',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: 'm1', role: 'user', createdAt: 1, content: 'hi', toolCalls: [] }],
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

describe('shareThreadTrace', () => {
  let workspaceDir: string
  let prevWorkspace: string | undefined
  let prevMockGh: string | undefined

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'copse-share-trace-'))
    prevWorkspace = process.env['COPSE_WORKSPACE_DIR']
    prevMockGh = process.env['COPSE_PANEL_MOCK_GH']
    process.env['COPSE_WORKSPACE_DIR'] = workspaceDir
    delete process.env['COPSE_PANEL_MOCK_GH']
    setShareTracePublisherForTest(async (opts) => ({
      prUrl: 'https://github.com/copse-dev/agent-pane/pull/42',
      prNumber: 42,
      branch: opts.branch,
    }))
  })

  afterEach(async () => {
    setShareTracePublisherForTest()
    if (prevWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = prevWorkspace
    if (prevMockGh === undefined) delete process.env['COPSE_PANEL_MOCK_GH']
    else process.env['COPSE_PANEL_MOCK_GH'] = prevMockGh
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('rejects empty threads', async () => {
    const empty: Thread = { ...sampleThread(), messages: [] }
    const result = await shareThreadTrace('proj', empty)
    assert.equal(result.ok, false)
    assert.match(result.message, /no messages/i)
  })

  it('attaches on-disk jsonl files and opens a PR via the publisher', async () => {
    const thread = sampleThread()
    const dir = join(workspaceDir, 'proj', thread.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'events.jsonl'), '{"type":"message","id":"m1"}\n', 'utf8')
    await writeFile(join(dir, 'meta.json'), '{"id":"tid-share-1"}\n', 'utf8')

    let publishedFiles: string[] = []
    setShareTracePublisherForTest(async (opts) => {
      publishedFiles = opts.files.map((f) => f.path)
      assert.match(opts.body, /events\.jsonl/)
      return {
        prUrl: 'https://github.com/copse-dev/agent-pane/pull/77',
        prNumber: 77,
        branch: opts.branch,
      }
    })

    const result = await shareThreadTrace('proj', thread)
    assert.equal(result.ok, true)
    assert.equal(result.prNumber, 77)
    assert.equal(result.prUrl, 'https://github.com/copse-dev/agent-pane/pull/77')
    assert.ok(publishedFiles.some((p) => p.endsWith('/thread.jsonl')))
    assert.ok(publishedFiles.some((p) => p.endsWith('/events.jsonl')))
    assert.ok(publishedFiles.some((p) => p.endsWith('/meta.json')))
  })

  it('returns a mock PR when COPSE_PANEL_MOCK_GH=1', async () => {
    process.env['COPSE_PANEL_MOCK_GH'] = '1'
    let called = false
    setShareTracePublisherForTest(async () => {
      called = true
      return { prUrl: 'nope', prNumber: 0, branch: 'nope' }
    })

    const result = await shareThreadTrace('proj', sampleThread())
    assert.equal(result.ok, true)
    assert.equal(result.prNumber, 9001)
    assert.equal(called, false)
  })

  it('surfaces publisher failures without throwing', async () => {
    setShareTracePublisherForTest(async () => {
      throw new Error('push denied')
    })
    const result = await shareThreadTrace('proj', sampleThread())
    assert.equal(result.ok, false)
    assert.equal(result.message, 'push denied')
  })
})
