import { z } from 'zod'

/**
 * On-disk supervised task records under a project workspace (issue #1081, P1).
 *
 * Layout (resolved Open Q1 in docs/plans/background-supervisor.md):
 *
 * ```
 * ~/.copse/workspace/<projectId>/tasks/<taskId>/
 *   meta.json      # mutable current task record
 *   audit.jsonl    # append-only lifecycle transitions
 * ```
 *
 * Override the workspace root with `COPSE_WORKSPACE_DIR` (same as threads).
 * This module is pure validation + path helpers — no fs/Electron — so fixtures
 * and reconcile helpers can unit-test without a store writer.
 *
 * Supervisor records are operational telemetry (#1068), not thread-spine lines.
 */

/** Task lifecycle states (binding contract in background-supervisor.md). */
export const TASK_STATES = [
  'queued',
  'running',
  'waiting',
  'blocked',
  'cancelled',
  'failed',
  'completed',
] as const
export type TaskState = (typeof TASK_STATES)[number]

export const TASK_TERMINAL_STATES = ['cancelled', 'failed', 'completed'] as const
export type TaskTerminalState = (typeof TASK_TERMINAL_STATES)[number]

export const TASK_PROVENANCE = ['user', 'agent', 'system', 'schedule'] as const
export type TaskProvenance = (typeof TASK_PROVENANCE)[number]

export const TASK_TRIGGER_KINDS = ['immediate', 'wake_at', 'event', 'cron'] as const
export type TaskTriggerKind = (typeof TASK_TRIGGER_KINDS)[number]

export const TASK_AUDIT_ACTIONS = [
  'enqueue',
  'start',
  'wake',
  'suspend',
  'block',
  'unblock',
  'cancel',
  'fail',
  'complete',
  'retry',
  'reassign',
  'reconcile',
] as const
export type TaskAuditAction = (typeof TASK_AUDIT_ACTIONS)[number]

export const taskStateSchema = z.enum(TASK_STATES)
export const taskProvenanceSchema = z.enum(TASK_PROVENANCE)
export const taskAuditActionSchema = z.enum(TASK_AUDIT_ACTIONS)

/** Wake / start trigger. Cron is accepted in the schema; arming is P4+. */
export const taskTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('immediate') }),
  z.object({ kind: z.literal('wake_at'), wakeAt: z.number().int() }),
  z.object({ kind: z.literal('event'), event: z.string().min(1) }),
  z.object({ kind: z.literal('cron'), expression: z.string().min(1) }),
])
export type TaskTrigger = z.infer<typeof taskTriggerSchema>

/**
 * Permission context captured at enqueue/schedule time. P1 keeps this typed but
 * opaque enough for fixtures; P2/P3 own wake-time fail-closed semantics.
 */
export const permissionSnapshotSchema = z.object({
  capturedAt: z.number().int(),
  autoRunSandboxCommands: z.boolean(),
  projectSandboxEnabled: z.boolean(),
  executionRoot: z.string().min(1).optional(),
  workspaceTargetKind: z.enum(['local', 'ssh']).optional(),
  capabilityProfileId: z.string().min(1).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
})
export type PermissionSnapshot = z.infer<typeof permissionSnapshotSchema>

export const taskResultRefSchema = z.object({
  kind: z.enum(['spine', 'blob', 'handler']),
  ref: z.string().min(1),
  sha256: z.string().min(1).optional(),
})
export type TaskResultRef = z.infer<typeof taskResultRefSchema>

export const taskResourceBudgetSchema = z.object({
  maxDurationMs: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
})
export type TaskResourceBudget = z.infer<typeof taskResourceBudgetSchema>

/** Durable task pointer under `tasks/<taskId>/meta.json`. */
export const supervisedTaskMetaSchema = z.object({
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  threadId: z.string().min(1),
  parentTaskId: z.string().min(1).optional(),
  /** Stable handler kind (e.g. `long_horizon_continue`, `shell_process`). */
  handler: z.string().min(1),
  provenance: taskProvenanceSchema,
  state: taskStateSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  startedAt: z.number().int().optional(),
  finishedAt: z.number().int().optional(),
  trigger: taskTriggerSchema,
  permissionSnapshot: permissionSnapshotSchema,
  reapproveOnWake: z.boolean(),
  concurrencyClass: z.string().min(1),
  resourceBudget: taskResourceBudgetSchema.optional(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  lastError: z.string().optional(),
  resultRef: taskResultRefSchema.optional(),
  /** Integrity hash when the payload will authorize later tool use. */
  contentHash: z.string().min(1).optional(),
  /** Session-scoped `run_background` handle; dead after process restart. */
  processHandleId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
})
export type SupervisedTaskMeta = z.infer<typeof supervisedTaskMetaSchema>

/** Compact support record retained after an old terminal task directory is removed. */
export const supervisedTaskArchiveSchema = z.object({
  v: z.literal(1),
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  threadId: z.string().min(1),
  handler: z.string().min(1),
  provenance: taskProvenanceSchema,
  state: z.enum(TASK_TERMINAL_STATES),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  finishedAt: z.number().int().optional(),
  attempt: z.number().int().nonnegative(),
  lastError: z.string().min(1).optional(),
  resultRef: taskResultRefSchema.optional(),
})
export type SupervisedTaskArchive = z.infer<typeof supervisedTaskArchiveSchema>

/** One append-only JSONL line in `tasks/<taskId>/audit.jsonl`. */
export const supervisedTaskAuditEventSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  taskId: z.string().min(1),
  action: taskAuditActionSchema,
  at: z.number().int(),
  fromState: taskStateSchema.optional(),
  toState: taskStateSchema,
  actor: taskProvenanceSchema.optional(),
  reason: z.string().optional(),
  fromThreadId: z.string().min(1).optional(),
  toThreadId: z.string().min(1).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
})
export type SupervisedTaskAuditEvent = z.infer<typeof supervisedTaskAuditEventSchema>

export function tasksDir(): string {
  return 'tasks'
}

export function taskDir(taskId: string): string {
  return `${tasksDir()}/${taskId}`
}

export function taskMetaPath(taskId: string): string {
  return `${taskDir(taskId)}/meta.json`
}

export function taskAuditPath(taskId: string): string {
  return `${taskDir(taskId)}/audit.jsonl`
}

export function isTerminalTaskState(state: TaskState): boolean {
  return (TASK_TERMINAL_STATES as readonly string[]).includes(state)
}

export function parseSupervisedTaskMeta(raw: unknown): SupervisedTaskMeta | null {
  const parsed = supervisedTaskMetaSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function parseSupervisedTaskAuditEvent(raw: unknown): SupervisedTaskAuditEvent | null {
  const parsed = supervisedTaskAuditEventSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Parse an audit JSONL body. Malformed / empty lines are skipped (forward-tolerant
 * like spine observability lines) so a single bad write does not hide history.
 */
export function parseSupervisedTaskAuditLog(jsonl: string): SupervisedTaskAuditEvent[] {
  const events: SupervisedTaskAuditEvent[] = []
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let raw: unknown
    try {
      raw = JSON.parse(trimmed) as unknown
    } catch {
      continue
    }
    const event = parseSupervisedTaskAuditEvent(raw)
    if (event) events.push(event)
  }
  return events
}

export function serializeSupervisedTaskAuditEvent(event: SupervisedTaskAuditEvent): string {
  return JSON.stringify(event)
}
