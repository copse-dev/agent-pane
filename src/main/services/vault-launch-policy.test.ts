import assert from 'node:assert/strict'
import { it } from 'node:test'
import { hasUnsafeVaultLaunchArguments } from './vault-launch-policy.ts'

const APP = '/Applications/Copse.app/Contents/MacOS/Copse'

it('rejects debugger and injected V8 launch options while keeping ordinary launches', () => {
  for (const option of [
    '--remote-debugging-port=9222',
    '--remote-debugging-pipe',
    '--remote-debugging-address=0.0.0.0',
    '--inspect=0',
    '--inspect-brk',
    '--inspect-port=9229',
    '--js-flags=--expose-gc',
    '--debug=5858',
    '--debug-brk',
  ]) {
    assert.equal(hasUnsafeVaultLaunchArguments([APP, option]), true, option)
  }
  assert.equal(hasUnsafeVaultLaunchArguments([APP, '--disable-gpu']), false)
  assert.equal(hasUnsafeVaultLaunchArguments([APP, '--debug-print']), false)
})

it('normalises single-dash, extra-dash and mixed-case switches the same way', () => {
  for (const option of [
    '-remote-debugging-port=9222',
    '-remote-debugging-pipe',
    '-inspect',
    '-inspect-brk=0',
    '-js-flags=--allow-natives-syntax',
    '---remote-debugging-port=9222',
    '--Remote-Debugging-Port=9222',
    '-JS-FLAGS=--expose-gc',
  ]) {
    assert.equal(hasUnsafeVaultLaunchArguments([APP, option]), true, option)
  }
})

it('ignores non-switch arguments such as document paths', () => {
  assert.equal(hasUnsafeVaultLaunchArguments([APP, '/tmp/inspect-notes.md']), false)
  assert.equal(hasUnsafeVaultLaunchArguments([APP, 'remote-debugging-port=9222']), false)
  assert.equal(hasUnsafeVaultLaunchArguments([APP, '-', '--']), false)
})
