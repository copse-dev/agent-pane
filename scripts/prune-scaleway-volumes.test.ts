import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pruneConfig } from './prune-scaleway-volumes.mts'

test('volume prune defaults to a 24-hour safety window across every Scaleway zone', () => {
  const config = pruneConfig({}, new Date('2026-07-23T12:00:00Z'))
  assert.equal(config.cutoff.toISOString(), '2026-07-22T12:00:00.000Z')
  assert.equal(config.zones.length, 10)
})

test('volume prune accepts an explicit age and zone', () => {
  const config = pruneConfig(
    { 'older-than-hours': '6', zone: 'fr-par-2' },
    new Date('2026-07-23T12:00:00Z'),
  )
  assert.equal(config.cutoff.toISOString(), '2026-07-23T06:00:00.000Z')
  assert.deepEqual(config.zones, ['fr-par-2'])
})

test('scheduled workflow runs the guarded managed-volume prune daily', () => {
  const workflow = readFileSync('.github/workflows/prune-scaleway-volumes.yml', 'utf8')
  assert.match(workflow, /schedule:/)
  assert.match(workflow, /cron: '17 3 \* \* \*'/)
  assert.match(workflow, /default: '24'/)
  assert.match(workflow, /scaleway:prune-volumes -- --yes --older-than-hours/)
})
