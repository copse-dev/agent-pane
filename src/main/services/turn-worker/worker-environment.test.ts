import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { quietWorkerEnvironment } from './worker-environment.ts'

describe('quietWorkerEnvironment', () => {
  it('keeps the launcher flag and the desktop password dialog from the turn', () => {
    const env: NodeJS.ProcessEnv = {
      ELECTRON_RUN_AS_NODE: '1',
      SSH_ASKPASS: '/usr/bin/ksshaskpass',
      DISPLAY: ':0',
      PATH: '/bin',
    }
    quietWorkerEnvironment(env)
    assert.deepEqual(env, { DISPLAY: ':0', PATH: '/bin', SSH_ASKPASS_REQUIRE: 'never' })
  })
})
