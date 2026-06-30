import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { at } from '@shared/array-utils.ts'
import { getActiveProjectRoot } from './workspace.ts'

/**
 * Experimental, opt-in "roadmap plans" feature (tracked in
 * https://github.com/jonathanKingston/agent-pane/issues/556).
 *
 * A roadmap is a notes-app-style backlog of *future prompts* — work we want
 * done over a longer time horizon than a single stacked PR covers. Each item
 * holds the prompt to run later plus a status the agent maintains, so it can
 * recognise when an item is still blocked by (or conflicts with) in-flight PRs
 * and avoid grinding out large amounts of work before those PRs merge.
 *
 * This is the storage scaffold only: items persist per project as JSON under
 * `~/.copse/roadmap/<workspace>/items.json`. Conflict classification against
 * open PRs and any UI surface are deliberately out of scope here — see the
 * issue. Off by default; gates the `roadmap_plan` tool registration
 * (registry-bootstrap) so the feature is fully inert until the user opts in via
 * Settings → Experimental.
 */
export const ROADMAP_PLANS_ENABLED_SETTING = 'roadmapPlansEnabled'

/**
 * Where a roadmap item sits relative to in-flight work. `ready` means nothing
 * blocks it; `blocked` / `conflicts` are set once conflict classification (a
 * follow-up) decides starting it now would collide with an open PR. `done` and
 * `archived` are terminal.
 */
export const ROADMAP_STATUSES = ['ready', 'blocked', 'conflicts', 'done', 'archived'] as const

export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number]

const roadmapItemSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  notes: z.string(),
  status: z.enum(ROADMAP_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type RoadmapItem = z.infer<typeof roadmapItemSchema>

const roadmapFileSchema = z.object({ items: z.array(roadmapItemSchema) })

let rootOverride: string | null = null

/** @internal test helper — point the store at a temp dir instead of `~/.copse`. */
export function setRoadmapRootForTest(path: string | null): void {
  rootOverride = path
}

function roadmapBaseDir(): string {
  return rootOverride ?? join(homedir(), '.copse', 'roadmap')
}

/**
 * Roadmap items are scoped per project, mirroring the memories store, so a
 * backlog for one repo never bleeds into another. With no workspace open they
 * fall back to a `shared` namespace.
 */
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
    .slice(0, 64)
}

function roadmapFile(): string {
  return join(roadmapBaseDir(), workspaceNamespace(), 'items.json')
}

/** Load this project's roadmap items, oldest first. Missing/corrupt file → []. */
export function loadRoadmapItems(): RoadmapItem[] {
  let raw: string
  try {
    raw = readFileSync(roadmapFile(), 'utf8')
  } catch {
    return []
  }
  try {
    return roadmapFileSchema.parse(JSON.parse(raw)).items
  } catch {
    return []
  }
}

function writeRoadmapItems(items: RoadmapItem[]): void {
  const file = roadmapFile()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ items }, null, 2)}\n`)
}

function nextId(existing: RoadmapItem[]): string {
  // Stable, readable, and collision-free without Math.random: monotonically
  // increasing per project.
  const max = existing.reduce((acc, item) => {
    const n = Number.parseInt(item.id.replace(/^r/, ''), 10)
    return Number.isFinite(n) && n > acc ? n : acc
  }, 0)
  return `r${String(max + 1)}`
}

export interface AddRoadmapItemInput {
  prompt: string
  notes?: string | undefined
}

/** Append a future-work prompt to the roadmap and return the stored item. */
export function addRoadmapItem(input: AddRoadmapItemInput): RoadmapItem {
  const items = loadRoadmapItems()
  const now = new Date().toISOString()
  const item: RoadmapItem = {
    id: nextId(items),
    prompt: input.prompt.trim(),
    notes: (input.notes ?? '').trim(),
    status: 'ready',
    createdAt: now,
    updatedAt: now,
  }
  writeRoadmapItems([...items, item])
  return item
}

/** Update an item's status. Returns the updated item, or null if not found. */
export function setRoadmapItemStatus(id: string, status: RoadmapStatus): RoadmapItem | null {
  const items = loadRoadmapItems()
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) return null
  const updated: RoadmapItem = {
    ...at(items, index),
    status,
    updatedAt: new Date().toISOString(),
  }
  items[index] = updated
  writeRoadmapItems(items)
  return updated
}
