import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { getActiveProjectRoot } from './workspace.ts'

/**
 * Per-project roadmap review checkpoint. Commit history for the next bulk run is
 * scoped to changes after `lastReviewAt`. Bulk-run ids tie each item's stamped
 * verdict to the pass that produced it (and whether the user acknowledged Close).
 */

const stateSchema = z.object({
  lastReviewAt: z.iso.datetime().nullable(),
  lastAcknowledgedBulkRun: z.string().nullable().optional(),
  pendingBulkRun: z.string().nullable().optional(),
})

export interface RoadmapReviewCheckpoint {
  lastReviewAt: string | null
  lastAcknowledgedBulkRun: string | null
  pendingBulkRun: string | null
}

let rootOverride: string | null = null

/** @internal test helper — point state at a temp dir instead of `~/.copse`. */
export function setRoadmapReviewRootForTest(path: string | null): void {
  rootOverride = path
}

function reviewBaseDir(): string {
  return rootOverride ?? join(homedir(), '.copse', 'roadmap-review')
}

function workspaceNamespace(): string {
  const root = getActiveProjectRoot()
  if (!root) return 'shared'
  const name = slugify(basename(root)) || 'workspace'
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8)
  return `${name}-${hash}`
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function statePath(): string {
  const dir = join(reviewBaseDir(), workspaceNamespace())
  mkdirSync(dir, { recursive: true })
  return join(dir, 'state.json')
}

function readState(): z.infer<typeof stateSchema> {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(statePath(), 'utf8')))
    if (parsed.success) return parsed.data
  } catch {
    // missing or corrupt — treat as never reviewed
  }
  return { lastReviewAt: null }
}

function writeState(state: z.infer<typeof stateSchema>): void {
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function normalizeCheckpoint(state: z.infer<typeof stateSchema>): RoadmapReviewCheckpoint {
  return {
    lastReviewAt: state.lastReviewAt,
    lastAcknowledgedBulkRun: state.lastAcknowledgedBulkRun ?? null,
    pendingBulkRun: state.pendingBulkRun ?? null,
  }
}

export function readRoadmapReviewCheckpoint(): RoadmapReviewCheckpoint {
  return normalizeCheckpoint(readState())
}

export function getRoadmapLastReviewAt(): string | null {
  return readState().lastReviewAt
}

export function setPendingBulkRun(runId: string): void {
  const state = readState()
  writeState({ ...state, pendingBulkRun: runId })
}

export function clearPendingBulkRun(runId: string): boolean {
  const state = readState()
  if (state.pendingBulkRun !== runId) return false
  writeState({ ...state, pendingBulkRun: null })
  return true
}

export function acknowledgeBulkRun(runId: string): boolean {
  const state = readState()
  if (state.pendingBulkRun !== runId) return false
  writeState({
    lastReviewAt: new Date().toISOString(),
    lastAcknowledgedBulkRun: runId,
    pendingBulkRun: null,
  })
  return true
}

/** @internal tests — direct timestamp write for legacy scenarios. */
export function setRoadmapLastReviewAt(iso: string): void {
  const state = readState()
  writeState({ ...state, lastReviewAt: iso })
}
