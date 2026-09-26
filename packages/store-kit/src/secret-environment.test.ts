import { it } from 'node:test'
import assert from 'node:assert/strict'
import { SecretEnvironment } from './secret-environment.ts'
it('clears injected credentials before relaunch while preserving external credentials', () => {
  const env: NodeJS.ProcessEnv = { EXTERNAL: 'original external', CHANGED: 'before' }
  const secrets = new SecretEnvironment(env)
  secrets.set('EXTERNAL', 'saved first')
  secrets.set('EXTERNAL', 'saved second')
  secrets.set('SAVED', 'saved only')
  secrets.set('CHANGED', 'saved change')
  env['CHANGED'] = 'external replacement'
  secrets.clear()
  assert.deepEqual(env, { EXTERNAL: 'original external', CHANGED: 'external replacement' })
  secrets.clear()
  assert.equal(env['EXTERNAL'], 'original external')
})
