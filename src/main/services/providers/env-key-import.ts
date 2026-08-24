// Bulk import of provider API keys discovered in the environment, shared by the
// `settings:importEnvKeys` IPC handler and its tests. Lives outside the handler
// so the consent gate, never-overwrite, and plaintext-refusal branches are
// testable without an Electron window.

import { getSetting, hasApiKey, setApiKey } from '../storage/settings.ts'
import { scanEnvForKeys, type DetectedKey } from './env-key-detection.ts'

/** Thrown when the `envKeyAutoDetectEnabled` consent flag has not been granted. */
export class EnvKeyImportConsentError extends Error {
  constructor() {
    super('Environment key detection has not been enabled')
    this.name = 'EnvKeyImportConsentError'
  }
}

export interface EnvKeyImportDeps {
  scan?: () => DetectedKey[]
  hasKey?: (provider: string) => boolean
  setKey?: (provider: string, value: string) => { ok: boolean }
  consentGranted?: () => boolean
}

export interface EnvKeyImportResult {
  imported: { provider: string; source: string }[]
  skipped: { provider: string; reason: string }[]
}

/**
 * Import every detected environment key whose provider isn't configured yet.
 * With `opts.providers`, only those slugs are considered — detections outside
 * the list are neither imported nor reported as skipped (the caller deliberately
 * left them out, e.g. an unticked row in onboarding).
 *
 * Gated on the `envKeyAutoDetectEnabled` consent flag; callers surface
 * {@link EnvKeyImportConsentError} as a validation error over IPC.
 */
export function importDetectedEnvKeys(
  opts: { providers?: readonly string[] } = {},
  deps: EnvKeyImportDeps = {},
): EnvKeyImportResult {
  const scan = deps.scan ?? scanEnvForKeys
  const hasKey = deps.hasKey ?? hasApiKey
  const setKey = deps.setKey ?? setApiKey
  const consentGranted =
    deps.consentGranted ?? ((): boolean => getSetting<boolean>('envKeyAutoDetectEnabled', false))

  if (!consentGranted()) throw new EnvKeyImportConsentError()

  const allowed = opts.providers ? new Set(opts.providers) : null
  const imported: { provider: string; source: string }[] = []
  const skipped: { provider: string; reason: string }[] = []
  for (const d of scan()) {
    if (allowed && !allowed.has(d.provider)) continue
    // Never overwrite a key the user has already configured.
    if (hasKey(d.provider)) {
      skipped.push({ provider: d.provider, reason: 'already-configured' })
      continue
    }
    // Honour the plaintext gate here too: a bulk env import must not write keys
    // unencrypted without consent. Skipped rather than silently stored in clear.
    // The user can add the key manually via the Settings UI where the per-save
    // confirm dialog lets them approve plaintext storage explicitly.
    const result = setKey(d.provider, d.value)
    if (!result.ok) {
      skipped.push({ provider: d.provider, reason: 'plaintext-storage-refused' })
      continue
    }
    imported.push({ provider: d.provider, source: d.source })
  }
  return { imported, skipped }
}
