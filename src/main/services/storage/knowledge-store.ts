import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { splitSkillMarkdown } from '../parse-skill-frontmatter.ts'
import { getActiveProjectRoot } from '../workspace.ts'

/**
 * Per-project store for durable *application knowledge* — facts, decisions, and
 * future-work intents the agent (and later the user, via an editor) authors and
 * returns to. Each note is an Open Knowledge Format (OKF) markdown file — YAML
 * frontmatter plus a markdown body — under
 * `~/.copse/knowledge/<workspace>/<type>/<uuid>.md`, so notes are human-readable,
 * git-friendly, portable, and searchable by the file tools.
 *
 * This is the editable, authored companion to the read-only chat store in
 * https://github.com/jonathanKingston/agent-pane/issues/644: both converge on OKF
 * files under `~/.copse`, but this store is *mutated in place* (statuses change,
 * notes get edited) where the chat store is an immutable transcript.
 *
 * Roles (tracked in issue #645):
 * - **Files are the source of truth** — a note reconstructs from its `.md` alone.
 * - **`index.jsonl` is a rebuildable ordering/list cache**, append-only with
 *   last-write-wins per id. It owns only ordering (and caches a few fields for
 *   fast listing); if lost or corrupt it is rebuilt by scanning the type dirs.
 *   Deliberately *not* an immutable event log — a status change or reorder is a
 *   superseding appended line.
 */

/** A single knowledge note. `body` is the prose (a memory's content, a roadmap
 * item's prompt); `fields` holds type-specific scalar frontmatter (e.g. a roadmap
 * note's `notes`). */
export interface KnowledgeNote {
  id: string
  type: string
  title: string
  body: string
  tags: string[]
  /** Type-specific lifecycle status, or null when the type has none. */
  status: string | null
  /** Extra type-specific scalar frontmatter, round-tripped verbatim. */
  fields: Record<string, string>
  createdAt: string
  updatedAt: string
  /** Absolute path of the backing OKF markdown file. */
  file: string
}

export interface AddKnowledgeNoteInput {
  type: string
  title: string
  body: string
  tags?: string[] | undefined
  status?: string | null | undefined
  fields?: Record<string, string> | undefined
}

export interface UpdateKnowledgeNoteInput {
  title?: string | undefined
  body?: string | undefined
  tags?: string[] | undefined
  status?: string | null | undefined
  fields?: Record<string, string> | undefined
}

/** One line of `index.jsonl`. Last write per id wins; `deleted` tombstones it. */
interface IndexRecord {
  id: string
  type: string
  order: number
  title: string
  status: string | null
  /** Path of the note file relative to the workspace knowledge dir. */
  file: string
  createdAt: string
  updatedAt: string
  deleted?: boolean
}

/** Frontmatter keys with dedicated fields on {@link KnowledgeNote}; everything
 * else parsed from the frontmatter lands in `fields`. */
const RESERVED_KEYS = new Set(['type', 'id', 'title', 'tags', 'status', 'createdAt', 'updatedAt'])

let rootOverride: string | null = null

/** @internal test helper — point the store at a temp dir instead of `~/.copse`. */
export function setKnowledgeRootForTest(path: string | null): void {
  rootOverride = path
}

function knowledgeBaseDir(): string {
  return rootOverride ?? join(homedir(), '.copse', 'knowledge')
}

/**
 * Knowledge is scoped per project so notes about one repo never leak into
 * another. The namespace is a readable slug of the workspace folder name plus a
 * short hash of its absolute path, mirroring the memories store. With no
 * workspace open they fall back to a `shared` namespace.
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

/** Absolute directory holding the current project's knowledge notes and index. */
export function knowledgeDir(): string {
  return join(knowledgeBaseDir(), workspaceNamespace())
}

function indexFile(): string {
  return join(knowledgeDir(), 'index.jsonl')
}

/** Relative path (from the workspace knowledge dir) of a note's file. */
function relFile(type: string, id: string): string {
  return join(slugify(type) || 'note', `${id}.md`)
}

// --- OKF serialization (lossless for scalar frontmatter) ---------------------

function yamlQuote(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')}"`
}

function unquoteScalar(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return v
}

function sanitizeTag(tag: string): string {
  // Tags render as an inline YAML flow sequence, so strip the delimiters that
  // would break the `[a, b]` form.
  return tag.replace(/[,[\]]/g, '').trim()
}

function serializeNote(note: KnowledgeNote): string {
  const tags = note.tags.map(sanitizeTag).filter(Boolean)
  const lines = [
    '---',
    `type: ${note.type}`,
    `id: ${note.id}`,
    `title: ${yamlQuote(note.title)}`,
    `tags: [${tags.join(', ')}]`,
  ]
  if (note.status !== null) lines.push(`status: ${note.status}`)
  lines.push(`createdAt: ${note.createdAt}`, `updatedAt: ${note.updatedAt}`)
  for (const [key, value] of Object.entries(note.fields)) {
    if (RESERVED_KEYS.has(key)) continue
    lines.push(`${key}: ${yamlQuote(value)}`)
  }
  lines.push('---', '', note.body.trim(), '')
  return lines.join('\n')
}

function frontmatterField(yaml: string, key: string): string | undefined {
  const match = yaml.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  return match ? unquoteScalar(match[1] ?? '') : undefined
}

function parseTags(yaml: string): string[] {
  const match = yaml.match(/^tags:[ \t]*\[(.*)\][ \t]*$/m)
  if (!match) return []
  return (match[1] ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function parseExtraFields(yaml: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of yaml.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/)
    if (!match) continue
    const key = match[1] ?? ''
    if (!key || RESERVED_KEYS.has(key)) continue
    fields[key] = unquoteScalar(match[2] ?? '')
  }
  return fields
}

function parseNoteFile(raw: string, file: string): KnowledgeNote | null {
  const split = splitSkillMarkdown(raw)
  if (!split) return null
  const { frontmatter, body } = split
  const type = frontmatterField(frontmatter, 'type')
  const id = frontmatterField(frontmatter, 'id')
  if (!type || !id) return null
  const status = frontmatterField(frontmatter, 'status')
  return {
    id,
    type,
    title: frontmatterField(frontmatter, 'title') ?? '',
    body: body.trim(),
    tags: parseTags(frontmatter),
    status: status === undefined ? null : status,
    fields: parseExtraFields(frontmatter),
    createdAt: frontmatterField(frontmatter, 'createdAt') ?? '',
    updatedAt: frontmatterField(frontmatter, 'updatedAt') ?? '',
    file,
  }
}

// --- index.jsonl (rebuildable ordering / list cache) -------------------------

function isIndexRecord(value: unknown): value is IndexRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}

/** Fold the append-only index into the current record per id (last wins),
 * dropping tombstoned ids. Missing/corrupt file → empty map. */
function foldIndex(): Map<string, IndexRecord> {
  const records = new Map<string, IndexRecord>()
  let raw: string
  try {
    raw = readFileSync(indexFile(), 'utf8')
  } catch {
    return records
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isIndexRecord(parsed)) records.set(parsed.id, parsed)
    } catch {
      // Skip a torn or malformed line rather than failing the whole load.
    }
  }
  for (const [id, record] of records) {
    if (record.deleted) records.delete(id)
  }
  return records
}

function appendIndex(record: IndexRecord): void {
  const file = indexFile()
  mkdirSync(join(file, '..'), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`)
}

function nextOrder(records: Map<string, IndexRecord>): number {
  let max = 0
  for (const record of records.values()) {
    if (record.order > max) max = record.order
  }
  return max + 1
}

function readNote(rel: string): KnowledgeNote | null {
  const abs = join(knowledgeDir(), rel)
  try {
    return parseNoteFile(readFileSync(abs, 'utf8'), abs)
  } catch {
    return null
  }
}

/** Every `.md` note file under the type subdirs, relative to the knowledge dir. */
function scanNoteFiles(): string[] {
  const base = knowledgeDir()
  let typeDirs: string[]
  try {
    typeDirs = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
  const files: string[] = []
  for (const dir of typeDirs) {
    let entries: string[]
    try {
      entries = readdirSync(join(base, dir))
    } catch {
      continue
    }
    for (const name of entries) {
      if (name.endsWith('.md')) files.push(join(dir, name))
    }
  }
  return files
}

// --- public API --------------------------------------------------------------

/** Create a knowledge note, returning the stored record. */
export function addKnowledgeNote(
  input: AddKnowledgeNoteInput,
  now: Date = new Date(),
): KnowledgeNote {
  const type = input.type.trim()
  if (!type) throw new Error('A knowledge note type is required.')
  const title = input.title.trim()
  const iso = now.toISOString()
  const id = randomUUID()
  const rel = relFile(type, id)
  const note: KnowledgeNote = {
    id,
    type,
    title,
    body: input.body.trim(),
    tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
    status: input.status ?? null,
    fields: input.fields ?? {},
    createdAt: iso,
    updatedAt: iso,
    file: join(knowledgeDir(), rel),
  }
  mkdirSync(join(note.file, '..'), { recursive: true })
  writeFileSync(note.file, serializeNote(note), 'utf8')
  appendIndex({
    id,
    type,
    order: nextOrder(foldIndex()),
    title: note.title,
    status: note.status,
    file: rel,
    createdAt: iso,
    updatedAt: iso,
  })
  return note
}

/** Apply a patch to a note (rewriting its file) and refresh the index. Returns
 * the updated note, or null if no note has that id. */
export function updateKnowledgeNote(
  id: string,
  patch: UpdateKnowledgeNoteInput,
  now: Date = new Date(),
): KnowledgeNote | null {
  const records = foldIndex()
  const record = records.get(id)
  if (!record) return null
  const current = readNote(record.file)
  if (!current) return null
  const updated: KnowledgeNote = {
    ...current,
    title: patch.title !== undefined ? patch.title.trim() : current.title,
    body: patch.body !== undefined ? patch.body.trim() : current.body,
    tags: patch.tags !== undefined ? patch.tags.map((t) => t.trim()).filter(Boolean) : current.tags,
    status: patch.status !== undefined ? patch.status : current.status,
    fields: patch.fields !== undefined ? patch.fields : current.fields,
    updatedAt: now.toISOString(),
  }
  writeFileSync(updated.file, serializeNote(updated), 'utf8')
  appendIndex({
    id,
    type: updated.type,
    order: record.order,
    title: updated.title,
    status: updated.status,
    file: record.file,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  })
  return updated
}

/** Set a note's lifecycle status. Returns the updated note, or null if unknown. */
export function setKnowledgeNoteStatus(
  id: string,
  status: string,
  now: Date = new Date(),
): KnowledgeNote | null {
  return updateKnowledgeNote(id, { status }, now)
}

/** Delete a note (file + index tombstone). Returns false if unknown. */
export function deleteKnowledgeNote(id: string, now: Date = new Date()): boolean {
  const records = foldIndex()
  const record = records.get(id)
  if (!record) return false
  try {
    rmSync(join(knowledgeDir(), record.file), { force: true })
  } catch {
    // Already gone; still tombstone the index so it stops appearing.
  }
  appendIndex({ ...record, deleted: true, updatedAt: now.toISOString() })
  return true
}

/** All notes for the current project in order, optionally filtered by type. Any
 * on-disk note missing from the index (hand-added, or a lost index) is healed in
 * at the end. */
export function loadKnowledgeNotes(type?: string): KnowledgeNote[] {
  const records = [...foldIndex().values()].sort((a, b) => a.order - b.order)
  const notes: KnowledgeNote[] = []
  const seen = new Set<string>()
  for (const record of records) {
    const note = readNote(record.file)
    if (!note) continue
    notes.push(note)
    seen.add(note.id)
  }
  for (const rel of scanNoteFiles()) {
    const note = readNote(rel)
    if (!note || seen.has(note.id)) continue
    seen.add(note.id)
    appendIndex({
      id: note.id,
      type: note.type,
      order: nextOrder(foldIndex()),
      title: note.title,
      status: note.status,
      file: rel,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    })
    notes.push(note)
  }
  return type ? notes.filter((note) => note.type === type) : notes
}

/** A single note by id, or null if unknown. */
export function getKnowledgeNote(id: string): KnowledgeNote | null {
  const record = foldIndex().get(id)
  return record ? readNote(record.file) : null
}

/** Notes whose title, tags, body, or extra fields contain every whitespace-
 * separated term in `query` (case-insensitive), optionally scoped to a type. */
export function searchKnowledgeNotes(query: string, type?: string): KnowledgeNote[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const notes = loadKnowledgeNotes(type)
  if (terms.length === 0) return notes
  return notes.filter((note) => {
    const haystack =
      `${note.title}\n${note.tags.join(' ')}\n${note.body}\n${Object.values(note.fields).join(' ')}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}
