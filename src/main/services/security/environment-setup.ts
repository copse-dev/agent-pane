import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { z } from 'zod'
import {
  AUTO_APPROVAL_LEVEL_SETTING,
  AUTO_APPROVAL_RANK,
  isAutoApprovalLevel,
  sanitizeAutoApprovalLevel,
  type AutoApprovalLevel,
} from '@shared/auto-approval.ts'
import type {
  EnvironmentSetupApplyResult,
  EnvironmentSetupChange,
  EnvironmentSetupReview,
  EnvironmentSetupStatus,
  EnvironmentSuggestion,
} from '@shared/environment-setup.ts'
import { WEB_ALLOWED_ORIGINS_SETTING } from '@shared/web-origins.ts'
import {
  sanitizeTrustedCommands,
  TRUSTED_COMMANDS_SETTING,
} from '@copse/shell-guard/trusted-commands.ts'
import {
  sanitizeTrustedSshHosts,
  TRUSTED_SSH_HOSTS_SETTING,
} from '@copse/shell-guard/trusted-ssh-hosts.ts'
import {
  sanitizeTrustedPackageRegistries,
  TRUSTED_PACKAGE_REGISTRIES_SETTING,
} from '@copse/shell-guard/trusted-package-registries.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/index.ts'
import { spawnRunsOnSshTarget } from '../../project-sandbox/spawn.ts'
import { getSetting, updateSetting } from '../storage/settings.ts'
import { storageAppendFile, storageReadFile, storageWriteFile } from '../storage/storage.ts'
import { getActiveProjectId, getWorkspaceRoot } from '../workspace.ts'
import { readPromptEvidence } from './environment-evidence.ts'
import {
  buildEnvironmentSuggestions,
  type DraftSuggestion,
  type SuggestionContext,
} from './environment-suggestions.ts'
import { configuredGitRemotes } from './git-remotes.ts'
import { validateWebOriginPattern, webAllowedOriginsWithDefaults } from './web-origin-policy.ts'
import { isWorkspaceTrusted } from './workspace-trust.ts'

/**
 * Environment setup (`docs/plans/environment-setup.md`): offer, review, apply
 * and undo suggestions for the fixed-rule permission settings.
 *
 * Main owns every value. A review is issued here under an opaque id; the
 * renderer sends back only which suggestion ids were ticked, and apply writes
 * the values computed here. There is no agent tool for any of it.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** History the review draws on. */
export const REVIEW_WINDOW_DAYS = 30
/** History the composer offer counts. */
const OFFER_WINDOW_DAYS = 7
/** Approved prompts the suggestions must cover before the composer offers them. */
export const OFFER_MIN_PROMPTS = 5
/** How long "Not now", or opening the review, hides the offer. */
const SNOOZE_MS = 14 * DAY_MS

const STATE_FILE = 'environment-setup.json'
const LOG_FILE = 'environment-setup.jsonl'

const stateSchema = z.object({
  dismissed: z.boolean().optional(),
  snoozedUntil: z.number().optional(),
})

type SetupState = z.infer<typeof stateSchema>

interface PendingReview {
  reviewId: string
  projectId: string
  suggestions: ReadonlyMap<string, DraftSuggestion>
}

/** One value an apply added, and what to restore if it is undone. */
interface AppliedValue {
  change: EnvironmentSetupChange
  /** The auto-approval level before a raise; absent for list additions. */
  previousLevel?: AutoApprovalLevel
}

let pending: PendingReview | null = null
const undoable = new Map<string, AppliedValue[]>()

async function readState(): Promise<SetupState> {
  const raw = await storageReadFile(STATE_FILE)
  if (raw === null) return {}
  return safeJsonParse(raw, decodeWithSchema(stateSchema)) ?? {}
}

async function writeState(state: SetupState): Promise<void> {
  await storageWriteFile(STATE_FILE, `${JSON.stringify(state)}\n`)
}

async function log(
  action: 'apply' | 'undo',
  change: EnvironmentSetupChange,
  evidence?: number,
): Promise<void> {
  const line = {
    at: Date.now(),
    action,
    source: 'environment-setup',
    kind: change.kind,
    value: change.value,
    ...(evidence !== undefined ? { approvals: evidence } : {}),
  }
  await storageAppendFile(LOG_FILE, `${JSON.stringify(line)}\n`).catch(() => undefined)
}

function normalizeOrigin(origin: string): string | null {
  try {
    return validateWebOriginPattern(origin)
  } catch {
    return null
  }
}

function suggestionContext(workspaceRoot: string | null): SuggestionContext {
  return {
    workspaceRoot,
    sandboxActive: isProjectSandboxEnabled() && !spawnRunsOnSshTarget(workspaceRoot),
    autoApprovalLevel: sanitizeAutoApprovalLevel(
      getSetting<unknown>(AUTO_APPROVAL_LEVEL_SETTING, null),
    ),
    configuredRemotes: configuredGitRemotes(workspaceRoot),
    trustedCommands: new Set(
      sanitizeTrustedCommands(getSetting<unknown>(TRUSTED_COMMANDS_SETTING, [])),
    ),
    trustedSshHosts: sanitizeTrustedSshHosts(getSetting<unknown>(TRUSTED_SSH_HOSTS_SETTING, [])),
    trustedPackageRegistries: sanitizeTrustedPackageRegistries(
      getSetting<unknown>(TRUSTED_PACKAGE_REGISTRIES_SETTING, []),
    ),
    webAllowedOrigins: webAllowedOriginsWithDefaults(
      getSetting<string[] | null>(WEB_ALLOWED_ORIGINS_SETTING, null),
    ),
    harm: {
      workspaceRoot,
      homeDir: homedir(),
      canonicalizePath: realpathSync.native,
      pathExists: existsSync,
    },
    normalizeOrigin,
  }
}

/**
 * Suggestions apply only where the settings they change take effect: a trusted
 * workspace with auto-run on. Trusted commands and auto-approval both require
 * it, and an untrusted repo should not prompt a review of its own history.
 */
function eligibleProject(): { projectId: string; workspaceRoot: string } | null {
  const projectId = getActiveProjectId()
  const workspaceRoot = getWorkspaceRoot()
  if (!projectId || !workspaceRoot) return null
  if (!isWorkspaceTrusted(workspaceRoot)) return null
  if (!getSetting<boolean>('autoRunSandboxCommands', true)) return null
  return { projectId, workspaceRoot }
}

async function suggestionsSince(
  days: number,
): Promise<{ projectId: string; drafts: DraftSuggestion[] } | null> {
  const project = eligibleProject()
  if (!project) return null
  const evidence = await readPromptEvidence(project.projectId, Date.now() - days * DAY_MS)
  return {
    projectId: project.projectId,
    drafts: buildEnvironmentSuggestions(evidence, suggestionContext(project.workspaceRoot)),
  }
}

export async function environmentSetupStatus(): Promise<EnvironmentSetupStatus> {
  const state = await readState()
  if (state.dismissed || (state.snoozedUntil ?? 0) > Date.now()) {
    return { offer: false, promptCount: 0 }
  }
  const result = await suggestionsSince(OFFER_WINDOW_DAYS)
  const promptCount = (result?.drafts ?? [])
    .filter((draft) => !draft.declined)
    .reduce((sum, draft) => sum + draft.approvals, 0)
  return { offer: promptCount >= OFFER_MIN_PROMPTS, promptCount }
}

export async function reviewEnvironmentSetup(): Promise<EnvironmentSetupReview> {
  const result = await suggestionsSince(REVIEW_WINDOW_DAYS)
  const reviewId = randomUUID()
  const issued = new Map<string, DraftSuggestion>()
  const suggestions: EnvironmentSuggestion[] = []
  for (const draft of result?.drafts ?? []) {
    const id = randomUUID()
    issued.set(id, draft)
    suggestions.push({ id, ...draft })
  }
  pending = result ? { reviewId, projectId: result.projectId, suggestions: issued } : null
  const state = await readState()
  await writeState({ ...state, snoozedUntil: Date.now() + SNOOZE_MS })
  return { reviewId, suggestions, windowDays: REVIEW_WINDOW_DAYS }
}

function changeOf(draft: DraftSuggestion): EnvironmentSetupChange {
  return { kind: draft.kind, value: draft.value, label: draft.label }
}

/** Add a value to a string-list setting; returns whether it was absent. */
async function addToList(
  key: string,
  value: string,
  sanitize: (current: unknown) => string[],
): Promise<boolean> {
  const result = { added: false }
  await updateSetting<unknown>(key, null, (current) => {
    const list = sanitize(current)
    if (list.includes(value)) return list
    result.added = true
    return [...list, value]
  })
  return result.added
}

async function removeFromList(
  key: string,
  value: string,
  sanitize: (current: unknown) => string[],
): Promise<void> {
  await updateSetting<unknown>(key, null, (current) => sanitize(current).filter((v) => v !== value))
}

function webOrigins(current: unknown): string[] {
  const saved = Array.isArray(current) ? current.filter((entry) => typeof entry === 'string') : null
  return webAllowedOriginsWithDefaults(saved)
}

async function applyDraft(draft: DraftSuggestion): Promise<AppliedValue | null> {
  const change = changeOf(draft)
  switch (draft.kind) {
    case 'auto-approval-level': {
      if (!isAutoApprovalLevel(draft.value)) return null
      const target = draft.value
      const raised: { from?: AutoApprovalLevel } = {}
      await updateSetting<unknown>(AUTO_APPROVAL_LEVEL_SETTING, null, (current) => {
        const level = sanitizeAutoApprovalLevel(current)
        // Only ever raise: a level the user has since set higher stays.
        if (AUTO_APPROVAL_RANK[level] >= AUTO_APPROVAL_RANK[target]) return level
        raised.from = level
        return target
      })
      return raised.from === undefined ? null : { change, previousLevel: raised.from }
    }
    case 'trusted-command':
      return (await addToList(TRUSTED_COMMANDS_SETTING, draft.value, sanitizeTrustedCommands))
        ? { change }
        : null
    case 'web-origin':
      return (await addToList(WEB_ALLOWED_ORIGINS_SETTING, draft.value, webOrigins))
        ? { change }
        : null
    case 'trusted-ssh-host':
      return (await addToList(TRUSTED_SSH_HOSTS_SETTING, draft.value, sanitizeTrustedSshHosts))
        ? { change }
        : null
    case 'trusted-package-registry':
      return (await addToList(
        TRUSTED_PACKAGE_REGISTRIES_SETTING,
        draft.value,
        sanitizeTrustedPackageRegistries,
      ))
        ? { change }
        : null
  }
}

async function revert(applied: AppliedValue): Promise<void> {
  const { kind, value } = applied.change
  switch (kind) {
    case 'auto-approval-level': {
      const previous = applied.previousLevel
      if (previous === undefined) return
      await updateSetting<unknown>(AUTO_APPROVAL_LEVEL_SETTING, null, (current) => {
        // Restore only if nobody has changed it since.
        const level = sanitizeAutoApprovalLevel(current)
        return level === value ? previous : level
      })
      return
    }
    case 'trusted-command':
      return removeFromList(TRUSTED_COMMANDS_SETTING, value, sanitizeTrustedCommands)
    case 'web-origin':
      return removeFromList(WEB_ALLOWED_ORIGINS_SETTING, value, webOrigins)
    case 'trusted-ssh-host':
      return removeFromList(TRUSTED_SSH_HOSTS_SETTING, value, sanitizeTrustedSshHosts)
    case 'trusted-package-registry':
      return removeFromList(
        TRUSTED_PACKAGE_REGISTRIES_SETTING,
        value,
        sanitizeTrustedPackageRegistries,
      )
  }
}

export async function applyEnvironmentSetup(
  reviewId: string,
  suggestionIds: readonly string[],
): Promise<EnvironmentSetupApplyResult> {
  const review = pending
  if (!review || review.reviewId !== reviewId || review.projectId !== getActiveProjectId()) {
    throw new Error('This review has expired. Open it again to see current suggestions.')
  }
  pending = null
  const applied: AppliedValue[] = []
  for (const id of new Set(suggestionIds)) {
    const draft = review.suggestions.get(id)
    if (!draft || draft.declined) continue
    const result = await applyDraft(draft)
    if (!result) continue
    applied.push(result)
    await log('apply', result.change, draft.approvals)
  }
  if (applied.length === 0) return { applied: [], undoId: null }
  const undoId = randomUUID()
  undoable.set(undoId, applied)
  return { applied: applied.map((value) => value.change), undoId }
}

export async function undoEnvironmentSetup(undoId: string): Promise<EnvironmentSetupChange[]> {
  const applied = undoable.get(undoId)
  if (!applied) return []
  undoable.delete(undoId)
  for (const value of applied) {
    await revert(value)
    await log('undo', value.change)
  }
  return applied.map((value) => value.change)
}

export async function dismissEnvironmentSetup(forever: boolean): Promise<void> {
  const state = await readState()
  await writeState(
    forever ? { ...state, dismissed: true } : { ...state, snoozedUntil: Date.now() + SNOOZE_MS },
  )
}
