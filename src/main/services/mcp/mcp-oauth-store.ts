import { createHash } from 'node:crypto'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { getSecretCipher, type SecretCipher } from '../storage/secret-cipher.ts'
import { deleteSetting, getSetting, setSetting } from '../storage/settings.ts'

// One encrypted record per remote MCP server URL. The key is the URL, not the
// server's name: a token is only ever presented to the resource it was issued
// for, so a project config that reuses a name for another URL gets nothing.
const MCP_OAUTH_SETTING_PREFIX = 'mcpOAuth.'

const tokensSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  id_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
})

const clientInformationSchema = z.looseObject({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
})

const recordSchema = z.strictObject({
  serverUrl: z.string().min(1),
  /** The loopback redirect URI the client was registered with. */
  redirectUrl: z.string().min(1),
  /**
   * The authorization server the client is registered with. A registration is
   * only valid there (MCP authorization, "Authorization Server Binding").
   */
  authorizationServer: z.string().min(1),
  clientInformation: clientInformationSchema,
  tokens: tokensSchema.optional(),
})

export type McpOAuthTokens = z.infer<typeof tokensSchema>
export type McpOAuthClientInformation = z.infer<typeof clientInformationSchema>
export type McpOAuthRecord = z.infer<typeof recordSchema>

const storedSecretSchema = z.object({ v: z.literal(1), enc: z.string().min(1) })

type StoredSecret = z.infer<typeof storedSecretSchema>

export interface McpOAuthStoreDependencies {
  getCipher: () => SecretCipher | null
  read: (key: string) => unknown
  write: (key: string, value: unknown) => Promise<void>
  remove: (key: string) => Promise<void>
}

const defaultDependencies: McpOAuthStoreDependencies = {
  getCipher: getSecretCipher,
  read: (key) => getSetting<unknown>(key, null),
  write: setSetting,
  remove: deleteSetting,
}

/** The URL identity a record is bound to: the server URL without its fragment. */
export function mcpOAuthServerIdentity(serverUrl: string): string {
  const url = new URL(serverUrl)
  url.hash = ''
  return url.href
}

function settingKey(serverUrl: string): string {
  const digest = createHash('sha256').update(mcpOAuthServerIdentity(serverUrl)).digest('hex')
  return `${MCP_OAUTH_SETTING_PREFIX}${digest}`
}

/** The stored sign-in for one server URL, or null when absent or unreadable. */
export function readMcpOAuthRecord(
  serverUrl: string,
  dependencies: McpOAuthStoreDependencies = defaultDependencies,
): McpOAuthRecord | null {
  const stored = storedSecretSchema.safeParse(dependencies.read(settingKey(serverUrl)))
  if (!stored.success) return null
  const cipher = dependencies.getCipher()
  if (!cipher) return null
  let text: string
  try {
    text = cipher.decryptString(Buffer.from(stored.data.enc, 'base64'))
  } catch {
    return null
  }
  const record = safeJsonParse(text, decodeWithSchema(recordSchema))
  if (record === null) return null
  // A record copied under another URL's key must not authorize that URL.
  return record.serverUrl === mcpOAuthServerIdentity(serverUrl) ? record : null
}

/** True only when a sign-in can be persisted without a plaintext fallback. */
export function canStoreMcpOAuth(
  dependencies: McpOAuthStoreDependencies = defaultDependencies,
): boolean {
  return dependencies.getCipher()?.isEncryptionAvailable() === true
}

/** Persist one server's sign-in, encrypted. Throws rather than write plaintext. */
export async function writeMcpOAuthRecord(
  record: McpOAuthRecord,
  dependencies: McpOAuthStoreDependencies = defaultDependencies,
): Promise<void> {
  const cipher = dependencies.getCipher()
  if (!cipher?.isEncryptionAvailable()) {
    throw new Error('Copse cannot store MCP sign-ins because secure storage is unavailable.')
  }
  const normalized: McpOAuthRecord = {
    ...record,
    serverUrl: mcpOAuthServerIdentity(record.serverUrl),
  }
  const stored: StoredSecret = {
    v: 1,
    enc: cipher.encryptString(JSON.stringify(normalized)).toString('base64'),
  }
  await dependencies.write(settingKey(record.serverUrl), stored)
}

/** Forget one server's sign-in. */
export function deleteMcpOAuthRecord(
  serverUrl: string,
  dependencies: McpOAuthStoreDependencies = defaultDependencies,
): Promise<void> {
  return dependencies.remove(settingKey(serverUrl))
}
