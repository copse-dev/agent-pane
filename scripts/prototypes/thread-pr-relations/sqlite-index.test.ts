import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SqlitePrRelationshipIndex } from './sqlite-index.mts'
import {
  ThreadPrRelationshipIndex,
  type RelationshipThread,
} from '@copse/thread-store/thread-pr-relations.ts'

test('benchmark indexes answer the same relationships, including updates, commits, and archives', () => {
  const pr = {
    owner: 'acme',
    repo: 'widgets',
    number: 42,
    url: 'https://github.com/acme/widgets/pull/42',
  }
  const threads: RelationshipThread[] = [
    {
      id: 'a',
      title: 'Producer',
      prRefs: [pr],
      prProductions: [{ pr, eventId: 'event', source: 'pr-create', createdAt: 1 }],
      commitProductions: [
        {
          repository: 'github.com/acme/widgets',
          sha: 'a'.repeat(40),
          source: 'git-commit',
          eventId: 'commit',
          createdAt: 1,
        },
      ],
    },
    { id: 'b', title: 'Reviewer', prRefs: [pr] },
  ]
  const file = new ThreadPrRelationshipIndex(threads)
  const db = new SqlitePrRelationshipIndex(':memory:')
  try {
    db.replaceAll(threads)
    assert.deepEqual(db.forPr(pr), file.forPr(pr))
    assert.deepEqual(db.forThread('a'), file.forThread('a'))
    assert.deepEqual(
      db.forCommit('github.com/acme/widgets', 'a'.repeat(40)),
      file.forCommit('github.com/acme/widgets', 'a'.repeat(40)),
    )
    const archived = { ...threads[1], id: 'b', title: 'Reviewer', archivedAt: 2 }
    file.upsert(archived)
    db.upsert(archived)
    assert.deepEqual(db.forPr(pr), file.forPr(pr))
  } finally {
    db.close()
  }
})
