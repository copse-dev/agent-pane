import { setSecretCipher } from './secret-cipher.ts'

const scramble = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0x5a))

/**
 * Stand an in-memory cipher in for the OS keyring through the same
 * `setSecretCipher` hook the Electron shell calls at boot, so `setApiKey`
 * encrypts and `getApiKey` decrypts without a keychain. Bytes are scrambled so
 * a raw `apiKey.*` record never holds the plaintext.
 */
export function installInMemorySecretCipher(): void {
  setSecretCipher({
    isEncryptionAvailable: () => true,
    encryptString: (text) => scramble(Buffer.from(text, 'utf8')),
    decryptString: (buffer) => scramble(buffer).toString('utf8'),
  })
}
