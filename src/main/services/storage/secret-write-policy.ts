/**
 * Plaintext secret persistence is an emergency compatibility escape hatch, not
 * a fallback Copse may select on its own. The exact value `1` is required so a
 * loosely populated environment cannot enable it accidentally.
 */
export const ALLOW_PLAINTEXT_SECRETS_ENV = 'COPSE_ALLOW_PLAINTEXT_SECRETS'

export type SecretWritePolicy =
  'encrypted' | 'plaintext-disabled' | 'plaintext-consent-required' | 'plaintext-approved'

export function resolveSecretWritePolicy(
  encryptionAvailable: boolean,
  allowPlaintext: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretWritePolicy {
  if (encryptionAvailable) return 'encrypted'
  if (env[ALLOW_PLAINTEXT_SECRETS_ENV] !== '1') return 'plaintext-disabled'
  return allowPlaintext ? 'plaintext-approved' : 'plaintext-consent-required'
}
