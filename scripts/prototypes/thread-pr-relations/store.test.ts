import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ThreadPrRelations } from './store.mts'

const a = { projectId: 'project', threadId: 'implement' }
const b = { projectId: 'project', threadId: 'review' }
const repo = 'github.com/acme/widgets'
const pr = { repository: repo, number: 42 }
const sha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const event = { eventId: 'commit-tool-1', runId: 'run-1', observedAt: 10 }

test('both views preserve many-to-many references without claiming production or ownership', () => {
  const store = new ThreadPrRelations()
  try {
    store.registerThread(a, 'Implement')
    store.registerThread(b, 'Review')
    store.linkPr(a, pr, 'referenced', 'message-1')
    store.linkPr(a, { ...pr, number: 43 }, 'referenced', 'message-1')
    store.linkPr(b, { ...pr, repository: 'GitHub.com/Acme/Widgets' }, 'referenced', 'message-2')
    store.linkPr(a, pr, 'referenced', 'message-1')
    store.linkPr(a, pr, 'referenced', 'message-3')
    assert.deepEqual(store.getPr(pr, a.projectId).relatedThreads, [
      { threadId: a.threadId, title: 'Implement', relationships: ['referenced'] },
      { threadId: b.threadId, title: 'Review', relationships: ['referenced'] },
    ])
    assert.deepEqual(store.getThread(a)?.pullRequests, [
      { ...pr, relationships: ['referenced'] },
      { ...pr, number: 43, relationships: ['referenced'] },
    ])
    assert.equal(store.getPr(pr, a.projectId).commits, null)
  } finally {
    store.close()
  }
})

test('PR creation proves creation of the PR but only an exact commit event proves commit provenance', () => {
  const store = new ThreadPrRelations()
  try {
    store.registerThread(a, 'Implement')
    store.registerThread(b, 'Review')
    store.linkPr(b, pr, 'created', 'pr-create-tool-1')
    store.observePrCommits(pr, [sha, otherSha], 20)
    store.recordCommit(a, repo, sha, event)
    const view = store.getPr(pr, a.projectId)
    assert.deepEqual(view.relatedThreads, [
      { threadId: a.threadId, title: 'Implement', relationships: ['contributed'] },
      { threadId: b.threadId, title: 'Review', relationships: ['created'] },
    ])
    assert.deepEqual(view.commits, [
      { sha, attribution: 'recorded', evidence: [{ ...a, title: 'Implement', ...event }] },
      { sha: otherSha, attribution: 'unknown', evidence: [] },
    ])
    assert.deepEqual(store.getThread(a)?.pullRequests, [{ ...pr, relationships: ['contributed'] }])
    // The same recorded object can belong to multiple PRs without a unique owner.
    store.observePrCommits({ ...pr, number: 43 }, [sha], 20)
    assert.equal(store.getThread(a)?.pullRequests.length, 2)
  } finally {
    store.close()
  }
})

test('force pushes replace membership; rewritten and unobserved commits remain unknown', () => {
  const store = new ThreadPrRelations()
  try {
    store.registerThread(a, 'Implement')
    store.recordCommit(a, repo, sha, event)
    store.observePrCommits(pr, [sha], 20)
    assert.equal(store.getPr(pr, a.projectId).commits?.[0]?.attribution, 'recorded')
    store.observePrCommits(pr, [otherSha], 30)
    assert.deepEqual(store.getPr(pr, a.projectId).relatedThreads, [])
    assert.deepEqual(store.getThread(a)?.pullRequests, [])
    assert.equal(store.getPr(pr, a.projectId).commits?.[0]?.attribution, 'unknown')
    assert.throws(() => {
      store.observePrCommits(pr, [sha], 20)
    }, /newer/)
    assert.throws(() => {
      store.observePrCommits(pr, [sha.slice(0, 7)], 40)
    }, /full Git/)
    assert.equal(store.getPr(pr, a.projectId).commitsObservedAt, 30)
    store.observePrCommits(pr, [], 40)
    assert.deepEqual(store.getPr(pr, a.projectId).commits, [])
    // Historical evidence is retained and can match another current PR snapshot.
    store.observePrCommits({ ...pr, number: 43 }, [sha], 50)
    assert.equal(
      store.getPr({ ...pr, number: 43 }, a.projectId).commits?.[0]?.attribution,
      'recorded',
    )
  } finally {
    store.close()
  }
})

test('repository, host, and authorized project isolate identities and attribution', () => {
  const store = new ThreadPrRelations()
  try {
    store.registerThread(a, 'Implement')
    const external = { ...a, projectId: 'other-project' }
    store.registerThread(external, 'Private thread')
    store.linkPr(external, pr, 'referenced', 'message-1')
    store.recordCommit(external, repo, sha, event)
    store.observePrCommits(pr, [sha], 20)
    assert.deepEqual(store.getPr(pr, a.projectId).relatedThreads, [])
    assert.equal(store.getPr(pr, a.projectId).commits?.[0]?.attribution, 'unknown')
    for (const repository of ['github.com/acme/other', 'github.example/acme/widgets']) {
      store.observePrCommits({ ...pr, repository }, [sha], 20)
      assert.equal(
        store.getPr({ ...pr, repository }, external.projectId).commits?.[0]?.attribution,
        'unknown',
      )
    }
    store.recordCommit(a, repo, sha, event)
    assert.equal(store.getPr(pr, a.projectId).commits?.[0]?.evidence[0]?.title, 'Implement')
  } finally {
    store.close()
  }
})

test('disk persistence, idempotent events, and conflicting event replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copse-thread-pr-'))
  const path = join(dir, 'relations.sqlite')
  let store = new ThreadPrRelations(path)
  try {
    store.registerThread(a, 'Implement')
    store.recordCommit(a, repo, sha, event)
    store.recordCommit(a, repo, sha, event)
    assert.throws(() => {
      store.recordCommit(a, repo, otherSha, event)
    }, /Conflicting/)
    assert.throws(() => {
      store.linkPr(a, pr, 'created', '')
    }, /CHECK/)
    assert.throws(() => {
      store.linkPr(b, pr, 'referenced', 'missing-thread')
    }, /FOREIGN KEY/)
    store.linkPr(a, pr, 'referenced', 'message-1')
    store.observePrCommits(pr, [sha], 20)
    const before = store.getPr(pr, a.projectId)
    assert.equal(before.commits?.[0]?.evidence.length, 1)
    store.close()
    store = new ThreadPrRelations(path)
    assert.deepEqual(store.getPr(pr, a.projectId), before)
    store.registerThread(a, 'Renamed')
    assert.equal(store.getPr(pr, a.projectId).relatedThreads[0]?.title, 'Renamed')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
