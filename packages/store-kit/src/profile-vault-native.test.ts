import { it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { nativeVaultTimeoutMs, vaultHelperRequirement } from './profile-vault-native.ts'
import { VaultError } from './profile-vault-crypto.ts'
it(
  'compiles the helper identity and entitlement restrictions with Apple’s requirement parser',
  { skip: process.platform !== 'darwin' },
  () => {
    // Parsing code requirements is read-only and never signs code or accesses a key.
    const parsed = execFileSync(
      '/usr/bin/csreq',
      ['-r', vaultHelperRequirement('VRQQV62MK3'), '-t'],
      { encoding: 'utf8' },
    )
    assert.match(parsed, /dev\.copse\.vault/)
    assert.match(parsed, /get-task-allow/)
  },
)
it('rejects code requirement injection before calling macOS', () => {
  assert.throws(() => vaultHelperRequirement('VRQQV62MK3" or true'), VaultError)
})
it('bounds startup operations but never times out an interactive native dialog', () => {
  for (const operation of ['status', 'create', 'unlock'] as const)
    assert.equal(nativeVaultTimeoutMs(operation), 120_000)
  for (const operation of ['backup', 'recover', 'set-auth'] as const)
    assert.equal(nativeVaultTimeoutMs(operation), null)
})
