import { app, safeStorage } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { copseUserDataDir } from '@copse/store-kit/copse-paths.ts'
import { createKeyringCipher, createMigratingCipher } from '@copse/store-kit/keyring-cipher.ts'
import { createOsKeyringStore } from '../src/main/services/storage/os-keyring.ts'
import { setSecretCipher } from '@copse/store-kit/secret-cipher.ts'
import { parseClassifierEvalArgs, writeClassifierEval } from './classifier-eval.ts'

async function main(): Promise<number> {
  const args = parseClassifierEvalArgs(process.argv.slice(2))
  if (!args.profile) throw new Error('Saved-profile mode requires --profile.')
  // Existing profiles only: explicit selection prevents app-init's legacy migration.
  const userData = copseUserDataDir()
  await stat(join(userData, 'settings.json'))
  process.env['COPSE_PANEL_USER_DATA'] = userData
  await import('../src/main/app-init.ts')
  await app.whenReady()
  const cipher = createMigratingCipher(createKeyringCipher(createOsKeyringStore()), {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plaintext) => safeStorage.encryptString(plaintext),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
  })
  // Deliberately omit shouldReencrypt: evals must not migrate stored keys or
  // schedule the app's secret sweep while another Copse process may be running.
  setSecretCipher({
    isEncryptionAvailable: () => cipher.isEncryptionAvailable(),
    decryptString: (encrypted) => cipher.decryptString(encrypted),
    encryptString: () => {
      throw new Error('The classifier eval runner cannot write saved keys.')
    },
  })
  const { createClassifierSession } =
    await import('../src/main/services/classifiers/classifier-service.ts')
  const session = createClassifierSession(args.profile)
  return writeClassifierEval(args, session.profile, (requests, options) =>
    session.invokeBatch(requests, options),
  )
}

void main().then(
  (code) => {
    app.exit(code)
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Saved classifier eval failed.')
    app.exit(2)
  },
)
