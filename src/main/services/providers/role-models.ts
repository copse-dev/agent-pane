// Role → model resolution: the read path for the indirection layer described in
// `docs/plans/model-roles-and-defaults.md` (Phase 1). A user assigns a model to
// a role (persisted in the `roleModels` setting); features that route through a
// role get that model, and everything else keeps working exactly as before.
//
// Back-compat by design: when a role has no assignment, resolution falls back to
// the legacy per-feature setting key, so behaviour is unchanged until a role is
// actually assigned. See `agent-roles.ts` (`LEGACY_ROLE_ALIASES`) for the full
// mapping; this module wires only the *renderer-writable* routing roles.

import type { AgentRoleId } from '@copse/llm/agent-roles.ts'
import { getSetting, getSettingTrimmed } from '../storage/settings.ts'

/**
 * Legacy routing setting → role, for the settings a role assignment may override.
 *
 * Deliberately excludes the main-only security settings `safetyModel` and
 * `reviewModel`: those are written through the guarded security IPC rather than
 * the generic renderer `settings:set` path, and routing them through the
 * renderer-writable `roleModels` bag would let a renderer set them via
 * `settings:set`. Their roles still exist in the registry; only their *store*
 * waits for the security-settings UI slice.
 */
export const ROUTED_SETTING_TO_ROLE: Readonly<Record<string, AgentRoleId>> = {
  localDefaultModel: 'coder',
  smallTasksModel: 'small-tasks',
  subagentModel: 'research',
}

export type RoleModels = Record<string, string>

export interface RoleModelReads {
  roleModels: RoleModels
  /** Reads the legacy per-feature setting (already trimmed). */
  legacy: (key: string, fallback: string) => string
}

/**
 * Pure resolution: a non-empty role assignment wins over the legacy per-feature
 * setting; otherwise the legacy value is used. No I/O — the store access is
 * injected — so it is cheap to unit-test. Keys with no role mapping (e.g. the
 * security settings) always resolve to their legacy value.
 */
export function resolveRoutedModel(
  settingKey: string,
  fallback: string,
  read: RoleModelReads,
): string {
  const roleId = ROUTED_SETTING_TO_ROLE[settingKey]
  if (roleId) {
    const assigned = read.roleModels[roleId]?.trim()
    if (assigned) return assigned
  }
  return read.legacy(settingKey, fallback)
}

/** The persisted role → model assignments (validated on read; `{}` when unset). */
export function getRoleModels(): RoleModels {
  return getSetting<RoleModels>('roleModels', {})
}

/**
 * Settings-backed routed lookup used by the model-resolution sites in place of a
 * bare `getSettingTrimmed(settingKey, fallback)`.
 */
export function routedModelSetting(settingKey: string, fallback = ''): string {
  return resolveRoutedModel(settingKey, fallback, {
    roleModels: getRoleModels(),
    legacy: (key, fb) => getSettingTrimmed(key, fb),
  })
}
