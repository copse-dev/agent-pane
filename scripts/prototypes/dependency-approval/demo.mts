import { DependencyApprovals } from './model.mts'
const approvals = new DependencyApprovals()
const scope = { project: 'demo', thread: 'thread-1', root: '/demo' }
const inputs = {
  'package.json': '{"dependencies":{"example":"1.0.0"}}',
  'pnpm-lock.yaml':
    "lockfileVersion: '9.0'\nimporters: {}\npackages:\n  example@1.0.0:\n    resolution: {integrity: sha512-demo}\n",
}
try {
  const first = approvals.review(scope, inputs)
  console.log('First review:', first)
  approvals.approve(scope, first.digest, inputs)
  console.log('Repeat install:', approvals.plan(scope, 'pnpm install', inputs))
  const changed = {
    ...inputs,
    'pnpm-lock.yaml':
      inputs['pnpm-lock.yaml'] + '  added@2.0.0:\n    resolution: {integrity: sha512-added}\n',
  }
  console.log('Dependency added:', approvals.review(scope, changed))
  approvals.approve(scope, approvals.review(scope, changed).digest, changed)
  console.log('After approval:', approvals.review(scope, changed).status)
  const otherChat = { ...scope, thread: 'thread-2', root: '/another-worktree' }
  console.log('Other chat/worktree:', approvals.review(otherChat, changed))
  console.log('Switch back to approved branch:', approvals.review(otherChat, inputs).status)
} finally {
  approvals.close()
}
