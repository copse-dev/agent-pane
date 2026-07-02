import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isWorkspaceMarkdownLinkHref, workspaceLinkTargetFromHref } from './workspace-link-href.ts'

describe('workspaceLinkTargetFromHref', () => {
  it('maps root-relative markdown paths to workspace candidates', () => {
    assert.deepEqual(workspaceLinkTargetFromHref('/docs/experiments/v2.md'), {
      candidate: 'docs/experiments/v2.md',
    })
    assert.deepEqual(workspaceLinkTargetFromHref('docs/experiments/v2.md'), {
      candidate: 'docs/experiments/v2.md',
    })
    assert.deepEqual(workspaceLinkTargetFromHref('./scripts/build.mts'), {
      candidate: 'scripts/build.mts',
    })
  })

  it('supports optional line/col and strips fragments', () => {
    assert.deepEqual(workspaceLinkTargetFromHref('/src/foo.ts:42:7#heading'), {
      candidate: 'src/foo.ts',
      line: 42,
      column: 7,
    })
  })

  it('rejects external and unsafe destinations', () => {
    assert.equal(workspaceLinkTargetFromHref('https://example.com/x'), null)
    assert.equal(workspaceLinkTargetFromHref('mailto:a@b.com'), null)
    assert.equal(workspaceLinkTargetFromHref('#section'), null)
    assert.equal(workspaceLinkTargetFromHref('../outside.md'), null)
    assert.equal(isWorkspaceMarkdownLinkHref('javascript:alert(1)'), false)
    assert.equal(isWorkspaceMarkdownLinkHref('/uri'), false)
    assert.equal(isWorkspaceMarkdownLinkHref('/docs/experiments/v2.md'), true)
  })
})
