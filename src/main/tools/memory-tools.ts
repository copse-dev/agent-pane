import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import { splitSkillMarkdown } from '../services/skills/parse-skill-frontmatter.ts'
import { getActiveProjectRoot } from '../services/workspace.ts'
import {
  addKnowledgeNote,
  loadKnowledgeNotes,
  searchKnowledgeNotes,
  updateKnowledgeNote,
  type KnowledgeNote,
} from '../services/storage/knowledge-store.ts'

/**
 * Experimental OKF memories feature. `remember`/`recall` persist durable project
 * knowledge as OKF markdown notes. Memories are now the `Memory` type in the
 * shared knowledge store (issue #645) rather than a bespoke `~/.copse/memories`
 * store; this setting still gates the tools and the memory system-prompt block.
 */
export const OKF_MEMORIES_ENABLED_SETTING = 'okfMemoriesEnabled'

/** Knowledge-note type used for memories. */
const MEMORY_TYPE = 'Memory'

function formatMemory(note: KnowledgeNote): string {
  const tags = note.tags.length ? ` [${note.tags.join(', ')}]` : ''
  const when = note.updatedAt ? ` — ${note.updatedAt}` : ''
  return `## ${note.title}${tags}${when}\n\n${note.body}`
}

export const rememberTool = defineTool({
  name: 'remember',
  description:
    'Persist a durable memory for this project as an Open Knowledge Format (OKF) markdown note. Use it for facts worth recalling in future sessions: project conventions, decisions, gotchas, environment or setup details. Re-using an existing title updates that memory instead of duplicating it.',
  parameters: z.object({
    title: z
      .string()
      .describe('Short, unique title. Reuse a title to update that memory instead of adding one.'),
    content: z.string().describe('The memory body as markdown.'),
    tags: z.array(z.string()).optional().describe('Optional tags to aid later retrieval.'),
  }),
  execute({ title, content, tags }) {
    migrateLegacyMemories()
    const cleanTitle = title.trim()
    const existing = loadKnowledgeNotes(MEMORY_TYPE).find((note) => note.title === cleanTitle)
    const note = existing
      ? (updateKnowledgeNote(existing.id, { body: content, tags: tags ?? existing.tags }) ??
        existing)
      : addKnowledgeNote({ type: MEMORY_TYPE, title: cleanTitle, body: content, tags })
    return `Saved memory "${note.title}" to ${note.file}`
  },
})

export const recallTool = defineTool({
  name: 'recall',
  description:
    'Recall previously stored project memories (OKF notes). Optionally filter with a query matched against titles, tags, and bodies; omit it to list every memory. Returns the matching memories as markdown.',
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe('Optional search terms — all must match. Omit to list every memory.'),
  }),
  execute({ query }) {
    migrateLegacyMemories()
    const trimmed = query?.trim() ?? ''
    const memories = trimmed
      ? searchKnowledgeNotes(trimmed, MEMORY_TYPE)
      : loadKnowledgeNotes(MEMORY_TYPE)
    if (memories.length === 0) {
      return trimmed
        ? `No memories match "${trimmed}".`
        : 'No memories stored yet for this project. Use the remember tool to add one.'
    }
    const header = `Found ${String(memories.length)} ${memories.length === 1 ? 'memory' : 'memories'}:`
    return [header, ...memories.map(formatMemory)].join('\n\n')
  },
})

// --- one-time migration of legacy `~/.copse/memories` notes -------------------
//
// Before issue #645 memories were their own OKF store under
// `~/.copse/memories/<workspace>/`. On first use we import any legacy notes into
// the knowledge store as `Memory` notes (skipping titles that already exist),
// then drop a marker so it never re-runs. Non-destructive: the legacy files are
// left in place.

const LEGACY_MARKER = '.migrated-to-knowledge'

let legacyRootOverride: string | null = null
let legacyMigrationDone = false

/** @internal test helper — point the legacy memories dir at a temp path. */
export function setLegacyMemoriesRootForTest(path: string | null): void {
  legacyRootOverride = path
  legacyMigrationDone = false
}

function legacyMemoriesBaseDir(): string {
  return legacyRootOverride ?? join(homedir(), '.copse', 'memories')
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function legacyMemoriesDir(): string {
  const root = getActiveProjectRoot()
  const ns = root
    ? `${slugify(basename(root)) || 'workspace'}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`
    : 'shared'
  return join(legacyMemoriesBaseDir(), ns)
}

function legacyField(yaml: string, key: string): string | undefined {
  const match = yaml.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  if (!match) return undefined
  const v = (match[1] ?? '').trim()
  return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"') : v
}

function legacyTags(yaml: string): string[] {
  const match = yaml.match(/^tags:[ \t]*\[(.*)\][ \t]*$/m)
  if (!match) return []
  return (match[1] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Import legacy memories into the knowledge store once per process. Returns the
 * number imported. Safe to call repeatedly. */
export function migrateLegacyMemories(): number {
  if (legacyMigrationDone) return 0
  legacyMigrationDone = true
  const dir = legacyMemoriesDir()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0 // No legacy memories for this project.
  }
  if (entries.includes(LEGACY_MARKER)) return 0

  const existingTitles = new Set(loadKnowledgeNotes(MEMORY_TYPE).map((note) => note.title))
  let imported = 0
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      const split = splitSkillMarkdown(readFileSync(file, 'utf8'))
      if (!split) continue
      const title = legacyField(split.frontmatter, 'title') || name.replace(/\.md$/, '')
      if (existingTitles.has(title)) continue
      addKnowledgeNote({
        type: MEMORY_TYPE,
        title,
        body: split.body,
        tags: legacyTags(split.frontmatter),
      })
      existingTitles.add(title)
      imported++
    } catch {
      // Skip an unreadable or malformed legacy note rather than aborting.
    }
  }
  try {
    writeFileSync(join(dir, LEGACY_MARKER), `migrated ${String(imported)} note(s)\n`)
  } catch {
    // A read-only legacy dir just means we may re-scan next process; the
    // title-existence check keeps re-import idempotent.
  }
  return imported
}
