import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { openPersistentStore } from '../storage/persistent-store.ts'
import { getSecretCipher } from '../storage/secret-cipher.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type { ChatGptPlanStatus } from '@shared/types/chatgpt-plan.ts'

const credentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
})

export const chatGptRegistrationSchema = z.object({
  clientId: z.string().min(1),
  subject: z.string().nullable(),
  label: z.string(),
  credentials: credentialsSchema.nullable(),
})

const stateSchema = z.object({
  hostId: z
    .string()
    .regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  activeClientId: z.string().nullable(),
  accounts: z.array(chatGptRegistrationSchema),
})

export type ChatGptRegistration = z.infer<typeof chatGptRegistrationSchema>
export type ChatGptPlanState = z.infer<typeof stateSchema>

export interface ChatGptPlanStore {
  read: () => ChatGptPlanState
  write: (state: ChatGptPlanState) => void
}

/** All tokens share a single encrypted settings record; never permit plaintext fallback. */
export function createChatGptPlanStore(): ChatGptPlanStore {
  const backing = openPersistentStore({ name: 'settings' })
  const key = 'chatgptPlanCredentials'
  return {
    read: (): ChatGptPlanState => {
      const stored = backing.get(key)
      if (stored === undefined) {
        return { hostId: `urn:uuid:${randomUUID()}`, activeClientId: null, accounts: [] }
      }
      const cipher = getSecretCipher()
      if (typeof stored !== 'string' || !cipher?.isEncryptionAvailable()) {
        throw new Error('Unlock secure storage to access your ChatGPT connection.')
      }
      const decoded = safeJsonParse(
        cipher.decryptString(Buffer.from(stored, 'base64')),
        decodeWithSchema(stateSchema),
      )
      if (!decoded)
        throw new Error('The saved ChatGPT connection is invalid. Restore your settings backup.')
      return decoded
    },
    write: (state): void => {
      const cipher = getSecretCipher()
      if (!cipher?.isEncryptionAvailable()) {
        throw new Error('Secure storage must be available before connecting ChatGPT.')
      }
      backing.set(
        key,
        cipher.encryptString(JSON.stringify(stateSchema.parse(state))).toString('base64'),
      )
    },
  }
}

export function chatGptPlanStatus(state: ChatGptPlanState): ChatGptPlanStatus {
  return {
    activeClientId: state.activeClientId,
    accounts: state.accounts.map((account) => ({
      clientId: account.clientId,
      label: account.label,
      connected: account.credentials !== null,
      planEnabled: account.credentials?.scopes.includes('chatgpt.tokens.use.direct') ?? false,
    })),
  }
}
