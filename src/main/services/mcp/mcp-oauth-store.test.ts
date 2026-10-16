import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setSecretCipher } from '../storage/secret-cipher.ts'
import {
  deleteMcpOAuthRecord,
  readMcpOAuthRecord,
  writeMcpOAuthRecord,
  type McpOAuthRecord,
} from './mcp-oauth-store.ts'

const scramble = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0x5a))

const SERVER_URL = 'https://mcp.example.test/mcp'

const record: McpOAuthRecord = {
  serverUrl: SERVER_URL,
  redirectUrl: 'http://127.0.0.1:43123/callback',
  authorizationServer: 'https://auth.example.test',
  clientInformation: { client_id: 'copse-client' },
  tokens: { access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh' },
}

describe('MCP OAuth store (default settings dependencies)', () => {
  afterEach(async () => {
    await deleteMcpOAuthRecord(SERVER_URL)
    setSecretCipher(null)
  })

  it('reads back a sign-in it wrote through the real settings store', async () => {
    // Inject the cipher at the OS-storage boundary; everything else is the
    // store's production wiring, which the injected-store tests bypass.
    setSecretCipher({
      isEncryptionAvailable: () => true,
      encryptString: (text) => scramble(Buffer.from(text, 'utf8')),
      decryptString: (buffer) => scramble(buffer).toString('utf8'),
    })

    await writeMcpOAuthRecord(record)

    assert.deepEqual(readMcpOAuthRecord(SERVER_URL), record)
  })
})
