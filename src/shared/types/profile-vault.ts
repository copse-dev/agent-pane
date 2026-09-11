export interface ProfileVaultStatus {
  state: 'disabled' | 'locked' | 'unlocking' | 'unlocked' | 'busy' | 'unavailable'
  recovery: 'not-backed-up' | 'verified'
  available: boolean
  enabled: boolean
}
export type ProfileVaultAction =
  | { action: 'enable'; backup: boolean }
  | { action: 'unlock' | 'lock' | 'backup' | 'recover' }
export type ProfileVaultResult = { ok: true } | { ok: false; reason: string }
export interface ProfileVaultApi {
  status(): Promise<ProfileVaultStatus>
  run(action: ProfileVaultAction): Promise<ProfileVaultResult>
}
