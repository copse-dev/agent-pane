export interface ProfileVaultStatus {
  state: 'disabled' | 'locked' | 'unlocking' | 'unlocked' | 'busy' | 'unavailable'
  recovery: 'not-backed-up' | 'verified'
  available: boolean
  enabled: boolean
  requireAuth?: boolean
  automatic?: boolean
  migrationFailed?: boolean
}
export type ProfileVaultAction =
  | { action: 'set-auth'; requireAuth: boolean }
  | { action: 'unlock' | 'backup' | 'recover' | 'retry-migration' }
export type ProfileVaultResult = { ok: true } | { ok: false; reason: string }
export interface ProfileVaultApi {
  status(): Promise<ProfileVaultStatus>
  run(action: ProfileVaultAction): Promise<ProfileVaultResult>
}
