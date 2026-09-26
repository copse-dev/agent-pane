import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReviewContext } from './context.ts'
import { CORRECTNESS_LENS, VISUAL_LENS, applicableLenses } from './lenses.ts'
import { buildConversation } from './pr-conversation.ts'
import { describeReviewImages } from './review-images.ts'
import { MAX_IMAGE_VIEWS, createReviewerToolExecutor, reviewerTools } from './reviewer-tools.ts'
import { createTestRepo, toolText, type TestRepo } from './test-repo.ts'

const signal = new AbortController().signal
const png = (...tail: number[]): Buffer =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail])

describe('view_image', () => {
  let repo: TestRepo
  let context: ReviewContext

  before(async () => {
    repo = await createTestRepo({ 'src/a.ts': 'export const a = 1\n' })
    await mkdir(join(repo.root, 'shots'), { recursive: true })
    await writeFile(join(repo.root, 'shots', 'toolbar.png'), png(1))
    const mergeBase = repo.commit('base screenshot')
    await writeFile(join(repo.root, 'shots', 'toolbar.png'), png(2))
    await writeFile(join(repo.root, 'shots', 'new.png'), png(3))
    repo.commit('head screenshots')
    const conversation = buildConversation('Tidy the toolbar', [
      {
        kind: 'comment',
        author: 'github-actions[bot]',
        bot: true,
        createdAt: '2026-09-02T00:00:00Z',
        body: '![after](https://shots.example/toolbar-after.png)',
      },
    ])
    const binary = (
      path: string,
      status: 'added' | 'modified',
    ): ReviewContext['files'][number] => ({
      path,
      status,
      additions: 0,
      deletions: 0,
      text: '',
      truncated: false,
      dropped: 'binary asset',
    })
    context = {
      mergeBase,
      headCommit: repo.git('rev-parse', 'HEAD'),
      head: { gitDir: join(repo.root, '.git'), workTree: repo.root },
      dirtyWorkingTree: false,
      files: [binary('shots/toolbar.png', 'modified'), binary('shots/new.png', 'added')],
      instructions: [],
      testMap: [],
      budgetChars: 1000,
      usedChars: 0,
      conversation,
    }
  })

  after(async () => {
    await repo.remove()
  })

  function executor(fetched: string[] = []): ReturnType<typeof createReviewerToolExecutor> {
    return createReviewerToolExecutor({
      headCheckout: repo.root,
      context,
      cell: null,
      shellDecision: 'deny',
      scrub: (text) => text,
      fetchRemoteImage: (url) => {
        fetched.push(url)
        return Promise.resolve(png(9))
      },
    })
  }

  it('is offered to every reviewer', () => {
    assert.ok(reviewerTools().some((tool) => tool.name === 'view_image'))
  })

  it('shows a changed image on head and on base, from the object database', async () => {
    const tools = executor()
    const head = await tools.execute('view_image', { path: 'shots/toolbar.png' }, signal, 'v1')
    const base = await tools.execute(
      'view_image',
      { path: 'shots/toolbar.png', side: 'base' },
      signal,
      'v2',
    )
    assert.ok(typeof head !== 'string' && typeof base !== 'string')
    assert.match(head.result, /^<external_content source="view_image">/)
    const [headImage] = head.images
    const [baseImage] = base.images
    assert.ok(headImage && baseImage)
    assert.equal(headImage.name, 'shots/toolbar.png (head)')
    assert.equal(baseImage.dataUrl, `data:image/png;base64,${png(1).toString('base64')}`)
    assert.equal(headImage.dataUrl, `data:image/png;base64,${png(2).toString('base64')}`)
    assert.match(
      toolText(
        await tools.execute('view_image', { path: 'shots/new.png', side: 'base' }, signal, 'v3'),
      ),
      /does not exist on base/,
    )
  })

  it('refuses any path the change does not add or modify as an image', async () => {
    assert.match(
      toolText(await executor().execute('view_image', { path: 'src/a.ts' }, signal, 'v')),
      /not an image this change adds or modifies; changed images: shots\/toolbar\.png, shots\/new\.png/,
    )
  })

  it('fetches a conversation image by id only, never by a URL the model supplies', async () => {
    const fetched: string[] = []
    const tools = executor(fetched)
    const shown = await tools.execute('view_image', { image: 'img-1' }, signal, 'c1')
    assert.ok(typeof shown !== 'string')
    assert.equal(shown.images[0]?.name, 'img-1: after')
    assert.deepEqual(fetched, ['https://shots.example/toolbar-after.png'])
    assert.match(
      toolText(
        await tools.execute('view_image', { image: 'https://evil.example/x.png' }, signal, 'c2'),
      ),
      /No conversation image/,
    )
    assert.deepEqual(fetched, ['https://shots.example/toolbar-after.png'])
  })

  it(`stops after ${String(MAX_IMAGE_VIEWS)} images`, async () => {
    const tools = executor()
    for (let index = 0; index < MAX_IMAGE_VIEWS; index++) {
      assert.notEqual(
        typeof (await tools.execute('view_image', { image: 'img-1' }, signal, `l${String(index)}`)),
        'string',
      )
    }
    assert.match(
      toolText(await tools.execute('view_image', { image: 'img-1' }, signal, 'over')),
      /the limit/,
    )
  })

  it('lists what there is to look at, for prompts', () => {
    assert.deepEqual(describeReviewImages(context), [
      'Images you can look at with view_image:',
      '- shots/toolbar.png (changed; head and base)',
      '- shots/new.png (changed; head and base)',
      '- img-1: after (comment by github-actions[bot] (bot))',
    ])
    assert.deepEqual(describeReviewImages({ ...context, files: [], conversation: undefined }), [])
  })

  it('runs the visual lens only when there is an image, unless it was asked for alone', () => {
    const blind = { ...context, files: [], conversation: undefined }
    const both = [CORRECTNESS_LENS, VISUAL_LENS]
    assert.deepEqual(applicableLenses(both, context).lenses, both)
    assert.deepEqual(applicableLenses(both, blind), {
      lenses: [CORRECTNESS_LENS],
      skipped: [VISUAL_LENS],
    })
    assert.deepEqual(applicableLenses([VISUAL_LENS], blind).lenses, [VISUAL_LENS])
  })
})
