import { ThreadPrRelations } from './store.mts'

const store = new ThreadPrRelations()
try {
  const implementation = { projectId: 'widgets', threadId: 'implementation' }
  const review = { projectId: 'widgets', threadId: 'review' }
  const pr = { repository: 'github.com/acme/widgets', number: 42 }
  store.registerThread(implementation, 'Implement widget')
  store.registerThread(review, 'Review widget')
  store.linkPr(implementation, pr, 'created', 'pr-create-result-1')
  store.linkPr(review, pr, 'referenced', 'message-1')
  store.linkPr(review, { ...pr, number: 43 }, 'referenced', 'message-2')
  store.recordCommit(implementation, pr.repository, 'a'.repeat(40), {
    eventId: 'commit-result-1',
    runId: 'run-1',
    observedAt: 10,
  })
  store.observePrCommits(pr, ['a'.repeat(40), 'b'.repeat(40)], 20)
  console.log(
    JSON.stringify(
      {
        prototype: 'SQLite relations with synthetic data; shared PR view/tool read model',
        threadView: store.getThread(review),
        prViewAndTool: store.getPr(pr, review.projectId),
      },
      null,
      2,
    ),
  )
} finally {
  store.close()
}
