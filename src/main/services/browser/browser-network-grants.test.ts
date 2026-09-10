import { it } from 'node:test'
import assert from 'node:assert/strict'
import { browserAllowedOrigins, grantBrowserOrigin } from './browser-network-grants.ts'
import {
  browserThreadScope,
  browserSessionPartition,
  BROWSER_SESSION_PARTITION,
  BROWSER_AGENT_SESSION_PARTITION,
  isBrowserSessionPartition,
} from '@shared/browser-session.ts'
import { setSetting } from '../storage/settings.ts'

it('isolates temporary browser grants and profiles by project and task', async () => {
  await setSetting('webAllowedOrigins', [])
  const first = browserThreadScope('project-a', 'thread')
  const second = browserThreadScope('project-b', 'thread')
  grantBrowserOrigin(first, 'https://approved.example:443')
  assert.deepEqual(browserAllowedOrigins(first), ['https://approved.example:443'])
  assert.deepEqual(browserAllowedOrigins(second), [])
  assert.notEqual(
    browserSessionPartition(BROWSER_SESSION_PARTITION, first),
    browserSessionPartition(BROWSER_AGENT_SESSION_PARTITION, first),
  )
  assert.equal(
    isBrowserSessionPartition(browserSessionPartition(BROWSER_SESSION_PARTITION, first)),
    true,
  )
})
