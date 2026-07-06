import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelComparison } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { createComparisonCardEl } from './comparison-panel.ts'

function fakeApi(
  resolutions: { candidate: string; path: string; kind?: 'file' | 'directory' }[] = [],
): ApiClient {
  return {
    index: {
      resolveFileReferences: async () =>
        resolutions.map((r) => ({ ...r, kind: r.kind ?? ('file' as const) })),
    },
  } as unknown as ApiClient
}

const done: ModelComparison = {
  status: 'done',
  models: { a: 'gpt-5', b: 'claude-opus-4-8', judge: 'claude-opus-4-8' },
  reviewA: 'A says **fine**.',
  reviewB: 'B found a bug.',
  synthesis: 'They **disagree** on line 10.',
  cost: '~$0.04',
}

describe('comparison panel', () => {
  it('renders both reviewer columns with their model labels and markdown', () => {
    const card = createComparisonCardEl(done, fakeApi())
    const titles = [
      ...card.querySelectorAll('.comparison-panel-columns .comparison-panel-col-title'),
    ].map((n) => n.textContent)
    assert.deepEqual(titles, ['gpt-5', 'claude-opus-4-8'])
    assert.equal(card.querySelector('.comparison-panel-columns strong')?.textContent, 'fine')
  })

  it('renders the judge synthesis and the cost line', () => {
    const card = createComparisonCardEl(done, fakeApi())
    assert.match(card.querySelector('.comparison-panel-synthesis')?.textContent ?? '', /disagree/)
    assert.equal(card.querySelector('.comparison-panel-cost')?.textContent, '~$0.04')
  })

  it('shows only the header while the comparison is still running', () => {
    const card = createComparisonCardEl(
      { status: 'running', models: done.models, reviewA: '', reviewB: '', synthesis: '' },
      fakeApi(),
    )
    assert.equal(card.querySelector('.comparison-panel-columns'), null)
    assert.match(card.querySelector('.comparison-panel-title')?.textContent ?? '', /Comparing/)
  })

  it('renders the error message when the run failed', () => {
    const card = createComparisonCardEl(
      {
        status: 'error',
        models: done.models,
        reviewA: '',
        reviewB: '',
        synthesis: '',
        error: 'Comparison declined.',
      },
      fakeApi(),
    )
    assert.equal(card.getAttribute('data-status'), 'error')
    assert.match(card.querySelector('.comparison-panel-error')?.textContent ?? '', /declined/)
  })

  it('linkifies file paths printed in a reviewer column', async () => {
    const card = createComparisonCardEl(
      { ...done, reviewA: 'The change in src/main/index.ts is risky.' },
      fakeApi([{ candidate: 'src/main/index.ts', path: 'src/main/index.ts' }]),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const link = card.querySelector<HTMLAnchorElement>('a.file-reference-link')
    assert.ok(link, 'expected the printed file path to be linkified')
    assert.equal(link.dataset['fileReferencePath'], 'src/main/index.ts')
  })
})
