import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createKeyringCipher } from '../storage/keyring-cipher.ts'
import { setSecretCipher } from '../storage/secret-cipher.ts'
import {
  canStoreSshCredentials,
  deleteStoredSshCredential,
  deleteStoredSshCredentials,
  getStoredSshCredential,
  listStoredSshCredentialHostIds,
  setStoredSshCredential,
} from './ssh-credential-store.ts'

const HOST = 'credential-store-test'
const PROMPT = '(me@dev.example) Password:'

function installTestCipher(): void {
  let dataKey: string | null = null
  setSecretCipher(
    createKeyringCipher({
      read: () => dataKey,
      write: (value) => {
        dataKey = value
      },
    }),
  )
}

afterEach(() => {
  deleteStoredSshCredentials(HOST)
  setSecretCipher(null)
})

describe('SSH credential store', () => {
  it('encrypts, reads, lists, and deletes a host-scoped credential', () => {
    installTestCipher()

    assert.equal(canStoreSshCredentials(), true)
    assert.equal(setStoredSshCredential(HOST, PROMPT, 'hunter2'), true)
    assert.equal(getStoredSshCredential(HOST, PROMPT), 'hunter2')
    assert.ok(listStoredSshCredentialHostIds().includes(HOST))

    deleteStoredSshCredential(HOST, PROMPT)
    assert.equal(getStoredSshCredential(HOST, PROMPT), null)
    assert.equal(listStoredSshCredentialHostIds().includes(HOST), false)
  })

  it('refuses plaintext persistence when no OS-keyring cipher is installed', () => {
    setSecretCipher(null)

    assert.equal(canStoreSshCredentials(), false)
    assert.equal(setStoredSshCredential(HOST, PROMPT, 'hunter2'), false)
    assert.equal(getStoredSshCredential(HOST, PROMPT), null)
  })
})
