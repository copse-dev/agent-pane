import assert from 'node:assert/strict'
import { it } from 'node:test'
import { hasUnsafeVaultLaunchArguments } from './vault-launch-policy.ts'

it('rejects debugger and injected V8 launch options while keeping ordinary launches', () => {
  for (const option of [
    '--remote-debugging-port=9222',
    '--remote-debugging-pipe',
    '--inspect=0',
    '--inspect-brk',
    '--js-flags=--expose-gc',
  ]) {
    assert.equal(hasUnsafeVaultLaunchArguments(['/Applications/Copse.app', option]), true)
  }
  assert.equal(hasUnsafeVaultLaunchArguments(['/Applications/Copse.app', '--disable-gpu']), false)
})
