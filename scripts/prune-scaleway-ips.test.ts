import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  parseScalewayIpId,
  parseScalewayIps,
  selectScalewayManagedOrphanIps,
} from './lib/cloud-hosts.mts'
import { pruneConfig } from './prune-scaleway-ips.mts'

test('ip prune defaults to a 120-second settle window across every Scaleway zone', () => {
  const config = pruneConfig({})
  assert.equal(config.settleSeconds, 120)
  assert.equal(config.zones.length, 10)
})

test('ip prune accepts an explicit settle window and zone', () => {
  const config = pruneConfig({ 'settle-seconds': '30', zone: 'fr-par-2' })
  assert.equal(config.settleSeconds, 30)
  assert.deepEqual(config.zones, ['fr-par-2'])
})

test('parseScalewayIps reads attachment from the server field and defaults the zone', () => {
  const ips = parseScalewayIps(
    JSON.stringify([
      { address: '1.2.3.4', id: 'ip-attached', server: { id: 'srv-1' }, tags: ['copse-burst'] },
      { address: '5.6.7.8', id: 'ip-free', server: null, tags: ['copse-burst'] },
      { address: '9.9.9.9', id: 'ip-other-zone', zone: 'nl-ams-2' },
    ]),
    'fr-par-1',
  )
  assert.deepEqual(
    ips.map((ip) => [ip.id, ip.attached, ip.zone]),
    [
      ['ip-attached', true, 'fr-par-1'],
      ['ip-free', false, 'fr-par-1'],
      ['ip-other-zone', false, 'nl-ams-2'],
    ],
  )
  assert.deepEqual(ips[2]?.tags, [])
})

test('parseScalewayIps accepts the enveloped list form', () => {
  const ips = parseScalewayIps(JSON.stringify({ ips: [{ id: 'ip-1' }] }), 'fr-par-3')
  assert.deepEqual(
    ips.map((ip) => ip.id),
    ['ip-1'],
  )
})

test('parseScalewayIpId reads both the bare and enveloped create response', () => {
  assert.equal(parseScalewayIpId(JSON.stringify({ id: 'ip-bare' })), 'ip-bare')
  assert.equal(parseScalewayIpId(JSON.stringify({ ip: { id: 'ip-wrapped' } })), 'ip-wrapped')
  assert.throws(
    () => parseScalewayIpId(JSON.stringify({ address: '1.2.3.4' })),
    /did not return an id/,
  )
})

test('orphan selection keeps attached, untagged and partially tagged IPs', () => {
  const required = ['copse-burst', 'copse-burst-runners']
  const ips = parseScalewayIps(
    JSON.stringify([
      { address: '1.1.1.1', id: 'attached', server: { id: 's' }, tags: required },
      { address: '2.2.2.2', id: 'orphan', server: null, tags: [...required, 'copse-burst-ci'] },
      { address: '3.3.3.3', id: 'untagged', server: null, tags: [] },
      { address: '4.4.4.4', id: 'partial', server: null, tags: ['copse-burst'] },
    ]),
    'fr-par-1',
  )
  assert.deepEqual(
    selectScalewayManagedOrphanIps(ips, required).map((ip) => ip.id),
    ['orphan'],
  )
})

test('scheduled workflow runs the guarded managed-IP prune daily', () => {
  const workflow = readFileSync('.github/workflows/prune-scaleway-ips.yml', 'utf8')
  assert.match(workflow, /schedule:/)
  assert.match(workflow, /cron: '47 3 \* \* \*'/)
  assert.match(workflow, /default: '120'/)
  assert.match(workflow, /scaleway:prune-ips -- --yes --settle-seconds/)
})
