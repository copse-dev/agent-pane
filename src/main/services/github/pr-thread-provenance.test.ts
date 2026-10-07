import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createThread,
  recordThreadPrRefs,
  recordThreadPrProduction,
  recordThreadCommitProduction,
} from '../thread-store.ts'
import { getPrThreadProvenanceText } from './pr-thread-provenance.ts'

test('PR tool separates creation, references, exact commit evidence and unknown attribution in its project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-pr-provenance-'))
  const previous = process.env['COPSE_WORKSPACE_DIR']
  process.env['COPSE_WORKSPACE_DIR'] = root
  const pr = {
    owner: 'acme',
    repo: 'widgets',
    number: 42,
    url: 'https://github.com/acme/widgets/pull/42',
  }
  const sha = 'a'.repeat(40)
  try {
    for (const [project, id] of [
      ['local', 'producer'],
      ['local', 'reviewer'],
      ['other', 'hidden'],
    ]) {
      if (!project || !id) throw new Error('Missing fixture')
      await createThread(project, {
        id,
        title: id,
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: 1,
        updatedAt: 1,
      })
      await recordThreadPrRefs(project, id, [pr])
    }
    await recordThreadPrProduction('local', 'producer', {
      pr,
      source: 'pr-create',
      eventId: 'created',
      createdAt: 1,
    })
    await recordThreadCommitProduction('local', 'reviewer', {
      repository: 'github.com/acme/widgets',
      sha,
      source: 'git-commit',
      eventId: 'committed',
      createdAt: 1,
    })
    const text = await getPrThreadProvenanceText('local', pr.url, [sha, 'b'.repeat(40)])
    assert.match(text, /producer: producer \(recorded PR creation\)/)
    assert.match(text, /reviewer: reviewer \(referenced\)/)
    assert.match(text, /recorded in reviewer \(reviewer\); events committed/)
    assert.match(text, new RegExp(`${'b'.repeat(40)}: unknown`))
    assert.doesNotMatch(text, /hidden/)
    const otherRepo = await getPrThreadProvenanceText('local', pr.url.replace('widgets', 'other'), [
      sha,
    ])
    assert.match(otherRepo, new RegExp(`${sha}: unknown`))
    assert.match(
      await getPrThreadProvenanceText('local', pr.url, undefined),
      /GitHub did not return commits/,
    )
    assert.match(await getPrThreadProvenanceText(null, pr.url, [sha]), /unavailable/)
  } finally {
    if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previous
    rmSync(root, { recursive: true, force: true })
  }
})
