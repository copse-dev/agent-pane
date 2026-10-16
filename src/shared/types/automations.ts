import { memberOf } from '@shared/member-of.ts'

/** A project-owned recurring schedule persisted by the automations plugin. */
export type AutomationLiveWorktreeLimit = 1 | 2 | 3

/**
 * One exact approval a schedule may reuse without interrupting a future run.
 *
 * Deliberately narrow: shell commands, file changes, web origins, and broad ACP
 * permission kinds are not representable here. Those approvals need a different
 * scope than an exact Copse action or MCP tool name.
 */
export interface AutomationPermission {
  kind: 'copse-action' | 'mcp-tool'
  toolName: string
}

/** One currently-selectable permission shown by the schedule editor. */
export interface AutomationPermissionOption {
  permission: AutomationPermission
  label: string
  detail: string
}

/** Stable key used to deduplicate grants without flattening their typed shape on disk. */
export function automationPermissionKey(permission: AutomationPermission): string {
  return JSON.stringify([permission.kind, permission.toolName])
}

export interface AutomationSchedule {
  id: string
  projectId: string
  name: string
  cron: string
  prompt: string
  model: string
  enabled: boolean
  /** Maximum unresolved linked checkouts this schedule may retain. Defaults to 1. */
  maxLiveWorktrees?: AutomationLiveWorktreeLimit
  /** Exact tools/actions explicitly allowed to run unattended for this schedule. */
  permissions?: AutomationPermission[]
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  lastCreatedThreadId?: string
  /** Most recent trigger skipped because retained worktrees filled the limit. */
  lastWorktreeLimitAt?: number
  /** The runs that held the worktree slots at that skip, so the user can act on them. */
  lastWorktreeLimitBlockedBy?: AutomationRetainedWorktree[]
  /** Most recent trigger that failed or was skipped for a reason the user should see. */
  lastProblem?: AutomationProblem
}

/**
 * Why a scheduled trigger did not start a run. Cleared by the next run that
 * starts, so it always describes the schedule's latest unresolved attempt.
 */
export interface AutomationProblem {
  at: number
  /** `failed`: the trigger threw. `pending-start`: an earlier run was never started. */
  kind: 'failed' | 'pending-start'
  message: string
  /** Machine-readable cause; see `describeAutomationFailure`. Absent on rows written by older builds. */
  code?: AutomationFailureCode | undefined
  /** The run the problem belongs to, when one exists. */
  threadId?: string | undefined
}

/** Every way an unattended run is known to fail to start, stall or die. */
export const AUTOMATION_FAILURE_CODES = [
  'approval-stalled',
  'no-model',
  'container-missing',
  'auth-expired',
  'worktree-failed',
  'scheduler-stopped',
  'unknown',
] as const
export type AutomationFailureCode = (typeof AUTOMATION_FAILURE_CODES)[number]
export const isAutomationFailureCode = memberOf(AUTOMATION_FAILURE_CODES)

/** Editable fields accepted by create/update IPC. Project ownership is separate. */
export interface AutomationScheduleInput {
  id?: string
  name: string
  cron: string
  prompt: string
  model: string
  enabled: boolean
  maxLiveWorktrees?: AutomationLiveWorktreeLimit
  permissions?: AutomationPermission[]
}

/**
 * What an event automation listens for. All kinds share one definition store and one
 * delivery inbox; the kind selects the poller, the filters and the delivery identity.
 */
export type EventAutomationTrigger =
  | {
      kind: 'github-ci-failed'
      repository: string
      /** Branch whose current head is watched. For a PR-scoped trigger, the PR's head ref when saved. */
      branch: string
      /** Workflow names that may trigger a run. Absent or empty means every workflow. */
      checks?: string[] | undefined
      /** Watch this pull request's current head instead of a branch. */
      pullRequest?: number | undefined
    }
  | {
      kind: 'github-pr-changed'
      repository: string
      baseBranch: string
      /** `ready-for-review`: a draft became ready. `new-commits`: a non-draft PR got a new head. */
      transition: PullRequestTransition
    }
  | { kind: 'github-issue-labeled'; repository: string; label: string }

export type PullRequestTransition = 'ready-for-review' | 'new-commits'

export type EventAutomationTriggerInput =
  | {
      kind: 'github-ci-failed'
      branch?: string | undefined
      checks?: string[] | undefined
      pullRequest?: number | undefined
    }
  | { kind: 'github-pr-changed'; baseBranch: string; transition: PullRequestTransition }
  | { kind: 'github-issue-labeled'; label: string }

/** Versioned event workflow. Existing cron schedules keep their stored shape until migrated. */
export interface BranchCiAutomation {
  v: 1
  id: string
  projectId: string
  name: string
  trigger: EventAutomationTrigger
  prompt: string
  model: string
  enabled: boolean
  maxLiveWorktrees: AutomationLiveWorktreeLimit
  revision: string
  createdAt: number
  updatedAt: number
  /** Recent delivery identities, advanced only after inbox admission. */
  seenDeliveries: string[]
  /** Pull requests last observed as drafts, so a later non-draft observation is a transition. */
  draftPullRequests?: number[] | undefined
  lastRunAt?: number | undefined
  lastCreatedThreadId?: string | undefined
  /** Latest unresolved failure to start or poll, cleared by the next run that starts. */
  lastProblem?: AutomationProblem | undefined
}

export interface BranchCiAutomationInput {
  id?: string
  name: string
  /** Legacy shorthand for a branch CI trigger; ignored when `trigger` is given. */
  branch?: string
  trigger?: EventAutomationTriggerInput
  prompt: string
  model: string
  enabled: boolean
  maxLiveWorktrees?: AutomationLiveWorktreeLimit
}

/** Why a finished run's worktree could not be recycled. */
export const AUTOMATION_RETAINED_REASONS = [
  'uncommitted-changes',
  'unmerged-commits',
  'unpushed-pull-request',
  'in-use',
] as const
export type AutomationRetainedReason = (typeof AUTOMATION_RETAINED_REASONS)[number]

/** A previous run whose checkout is still holding one of the schedule's worktree slots. */
export interface AutomationRetainedWorktree {
  threadId: string
  title: string
  reason: AutomationRetainedReason
  /** A few changed paths for `uncommitted-changes`, so the user can judge what is at stake. */
  paths?: string[]
}

/** What a user-requested cleanup of one schedule's finished runs achieved. */
export interface AutomationCleanupResult {
  /** Runs whose checkout was removed, or was already gone. */
  released: string[]
  /** Runs that still hold a worktree, and why. Never discarded without the user's say-so. */
  retained: AutomationRetainedWorktree[]
}

/** One recorded delivery for an event automation, as the manager shows it. */
export interface EventDeliverySummary {
  key: string
  deliveryId: string
  /** `started`: a task exists. `waiting`: held back by a limit, rechecked later. `filtered`/`held`: will not run. */
  outcome: 'started' | 'waiting' | 'filtered' | 'held'
  /** Plain-language reason for every outcome other than a clean start. */
  reason?: string
  summary: string
  url?: string
  receivedAt: number
  threadId?: string
}

export interface AutomationTriggerEvent {
  projectId: string
  scheduleId: string
  threadId: string
  triggeredAt: number
  /** Whether this trigger started a turn or found the schedule's prior turn still active. */
  disposition: 'started' | 'coalesced'
  /** Why a fresh task could not safely start. Present only when coalesced. */
  coalescedReason?: 'busy' | 'worktree-limit'
  /** The runs holding worktree slots. Present only when coalesced for `worktree-limit`. */
  blockedBy?: AutomationRetainedWorktree[]
}

/** Whether the minute scheduler that fires schedules (and polls event triggers) is alive. */
export interface AutomationSchedulerHealth {
  /** `recovering`: the scheduler task died and a replacement is pending. `stopped`: replacement failed. */
  state: 'ok' | 'recovering' | 'stopped'
  /** When the current non-ok state began. */
  since: number | null
  message: string | null
}

/** What an event trigger would have matched recently, shown by Test match. */
export interface EventMatchPreview {
  repository: string
  /** The watched branch (CI) or base branch (pull requests); empty for issue labels. */
  branch: string
  latestFailure: string | null
  /** Recent items the trigger would have matched, newest first, already bounded for display. */
  recent: string[]
}
