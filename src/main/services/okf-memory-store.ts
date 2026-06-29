import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { splitSkillMarkdown } from './parse-skill-frontmatter.ts'
import { getActiveProjectRoot } from './workspace.ts'

/**
 * Experimental, opt-in "memories" feature. When enabled, the agent gets
 * `remember`/`recall` tools that persist durable project knowledge as
 * Open Knowledge Format (OKF) markdown notes — YAML frontmatter plus a markdown
 * body — under `~/.copse/memories/<workspace>/`. OKF is "just markdown, just
 * files, just YAML frontmatter": each note is human-readable, git-friendly, and
 * portable, with `type` the only mandatory field.
 *
 * Off by default; gates the tool registration (registry-bootstrap) and the
 * memory section of the system prompt (agent-system-prompt) so the feature is
 * fully inert until the user opts in via Settings → Experimental.
 */
export const OKF_MEMORIES_ENABLED_SETTING = 'okfMemoriesEnabled'

/** The OKF `type` written into every memory note's frontmatter. */
const MEMORY_TYPE = 'Memory'

export interface OkfMemory {
  title: string
  description: string
  tags: string[]
  timestamp: string
  body: string
  /** Absolute path of the backing OKF markdown file. */
  file: string
}

export interface SaveMemoryInput {
  title: string
  content: string
  tags?: string[] | undefined
}

let rootOverride: string | null = null

/** @internal test helper — point the store at a temp dir instead of `~/.copse`. */
export function setMemoriesRootForTest(path: string | null): void {
  rootOverride = path
}

function memoriesBaseDir(): string {
  return rootOverride ?? join(homedir(), '.copse', 'memories')
}

/**
 * Memories are scoped per project so notes about one repo never leak into
 * another. The namespace is a readable slug of the workspace folder name plus a
 * short hash of its absolute path, so two folders that share a basename get
 * distinct directories. With no workspace open they fall back to a `shared`
 * namespace.
 */
function workspaceNamespace(): string {
  const root = getActiveProjectRoot()
  if (!root) return 'shared'
  const name = slugify(basename(root)) || 'workspace'
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8)
  return `${name}-${hash}`
}

/** Absolute directory holding the current project's memory notes. */
export function memoriesDir(): string {
  return join(memoriesBaseDir(), workspaceNamespace())
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return (line ?? '').replace(/^#+\s*/, '').slice(0, 200)
}

function yamlQuote(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')}"`
}

function sanitizeTag(tag: string): string {
  // Tags render as an inline YAML flow sequence, so strip the delimiters that
  // would break the `[a, b]` form.
  return tag.replace(/[,[\]]/g, '').trim()
}

function serializeMemory(memory: {
  title: string
  description: string
  tags: string[]
  timestamp: string
  body: string
}): string {
  const tags = memory.tags.map(sanitizeTag).filter(Boolean)
  return [
    '---',
    `type: ${MEMORY_TYPE}`,
    `title: ${yamlQuote(memory.title)}`,
    `description: ${yamlQuote(memory.description)}`,
    `tags: [${tags.join(', ')}]`,
    `timestamp: ${memory.timestamp}`,
    '---',
    '',
    memory.body.trim(),
    '',
  ].join('\n')
}

function unquoteScalar(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return v
}

function frontmatterField(yaml: string, key: string): string {
  const match = yaml.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  return match ? unquoteScalar(match[1]!) : ''
}

function parseTags(yaml: string): string[] {
  const match = yaml.match(/^tags:[ \t]*\[(.*)\][ \t]*$/m)
  if (!match) return []
  return match[1]!
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

/**
 * Persist a memory as an OKF note. The title is also the filename (slugified),
 * so re-using a title updates the existing note rather than duplicating it. The
 * first non-empty content line becomes the OKF `description`.
 */
export function saveMemory(input: SaveMemoryInput, now: Date = new Date()): OkfMemory {
  const title = input.title.trim()
  if (!title) throw new Error('A memory title is required.')
  const body = input.content.trim()
  if (!body) throw new Error('Memory content is required.')

  const tags = (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean)
  const description = firstLine(body)
  const timestamp = now.toISOString()

  const dir = memoriesDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${slugify(title) || 'memory'}.md`)
  writeFileSync(file, serializeMemory({ title, description, tags, timestamp, body }), 'utf-8')

  return { title, description, tags, timestamp, body, file }
}

/** Load every memory for the current project, newest first. */
export function loadMemories(): OkfMemory[] {
  const dir = memoriesDir()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return [] // No memories directory yet.
  }

  const memories: OkfMemory[] = []
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      const split = splitSkillMarkdown(readFileSync(file, 'utf-8'))
      if (!split) continue
      const { frontmatter, body } = split
      memories.push({
        title: frontmatterField(frontmatter, 'title') || name.replace(/\.md$/, ''),
        description: frontmatterField(frontmatter, 'description'),
        tags: parseTags(frontmatter),
        timestamp: frontmatterField(frontmatter, 'timestamp'),
        body: body.trim(),
        file,
      })
    } catch {
      // Skip unreadable or malformed notes rather than failing the whole recall.
    }
  }

  return memories.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

/**
 * Memories whose title, tags, description, or body contain every whitespace-
 * separated term in `query` (case-insensitive). An empty query returns all.
 */
export function searchMemories(query: string): OkfMemory[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return loadMemories()
  return loadMemories().filter((memory) => {
    const haystack =
      `${memory.title}\n${memory.description}\n${memory.tags.join(' ')}\n${memory.body}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}
