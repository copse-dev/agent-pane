import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { setSetting } from '../storage/settings.ts'
import {
  projectAllowsPortBinding,
  rememberProjectPortBinding,
  revokeProjectPortBinding,
} from './project-port-grants.ts'

beforeEach(async () => {
  await setSetting('portBindingAllowedRoots', [])
})

test('a remembered port grant belongs to its project and revocation preserves other projects', async () => {
  await rememberProjectPortBinding('/project/a')
  assert.equal(projectAllowsPortBinding('/project/a'), true)
  assert.equal(projectAllowsPortBinding('/project/b'), false)
  await rememberProjectPortBinding('/project/b')
  await revokeProjectPortBinding('/project/a')
  assert.equal(projectAllowsPortBinding('/project/a'), false)
  assert.equal(projectAllowsPortBinding('/project/b'), true)
})

test('interleaved grant and revoke writes never drop another project grant', async () => {
  await rememberProjectPortBinding('/project/a')
  await Promise.all([
    rememberProjectPortBinding('/project/b'),
    revokeProjectPortBinding('/project/a'),
  ])
  assert.equal(projectAllowsPortBinding('/project/a'), false)
  assert.equal(projectAllowsPortBinding('/project/b'), true)
})
