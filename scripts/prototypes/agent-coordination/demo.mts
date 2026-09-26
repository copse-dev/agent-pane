import assert from 'node:assert/strict'
import { CoordinationBroker } from './broker.mts'

// Scripted agents, no providers or real task state. Reproduces the coordination
// pattern from the supplied screenshot without treating it as authorization.
const broker = new CoordinationBroker(() => 1_000)
const shared = {
  scopeId: 'copse-repo-approved-provider-group',
  optedIn: true,
}
const about = broker.join({
  ...shared,
  threadId: 'about-and-licenses',
  runId: 'about-run',
  checkoutId: 'about-worktree',
})
const lint = broker.join({
  ...shared,
  threadId: 'notices-staleness-lint',
  runId: 'lint-run',
  checkoutId: 'lint-worktree',
})

about.port.claim(['scripts/third-party-licenses.mts', 'THIRD_PARTY_NOTICES.md'])
lint.port.claim(['scripts/check-notices.mts', 'THIRD_PARTY_NOTICES.md'])
const collision = about.port.inspect()[0]
assert.ok(collision)
assert.equal(collision.risk, 'merge-conflict')

about.port.send(
  collision.id,
  'I am adding the license collector. Can you own THIRD_PARTY_NOTICES.md generation and reuse my collector?',
)
const request = lint.port.poll()[0]
assert.ok(request)
lint.port.send(
  collision.id,
  'Agreed. I will own the notices file and import your collector. Keep your edits to the collector; I will verify its interface before using it.',
)
const response = about.port.poll()[0]
assert.ok(response)
about.port.claim(['scripts/third-party-licenses.mts'])
assert.deepEqual(about.port.inspect(), [])

// Communication cannot authorize a follow-up after Stop or survive into a new run.
lint.stop()
assert.throws(() => about.port.send(collision.id, 'Please resume'), /No current overlapping/)
about.stop()

const result = {
  prototype: 'Scripted, in-memory coordination; no live agents, edits, or model calls',
  collision,
  request,
  response,
  outcome: 'About owns the collector; lint owns the notices file. No remaining declared overlap.',
  records: broker.records(),
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(result.prototype)
  console.log(`\n1. Detected ${collision.risk}: ${collision.paths.join(', ')}`)
  console.log(`2. About → lint [untrusted context]: ${request.text}`)
  console.log(`3. Lint → about [untrusted context]: ${response.text}`)
  console.log(`4. ${result.outcome}`)
  console.log('5. Stopped tasks cannot receive new messages. Permission policy was never touched.')
  console.log(`\n${String(result.records.length)} journal records; use --json to inspect.`)
}
