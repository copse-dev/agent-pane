import { createHash } from 'node:crypto'
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  closeSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { resolveInsideWithoutSymlinks, resolveProjectDir } from './environment.ts'
import { parseSpine } from './spine-schema.ts'
import { parseOkfMessage } from './okf-message.ts'

const INDEX_FILE = '.thread-prompt-index.sqlite'
const metaDecoder = decodeWithSchema(z.object({ archivedAt: z.number().optional() }))
const rowDecoder = decodeWithSchema(
  z.array(
    z.object({
      key: z.string(),
      text: z.string(),
    }),
  ),
)

export interface PromptSearchResult {
  matches: string[]
  incomplete: boolean
}

function normalizePromptSearch(text: string): string {
  return text.normalize('NFC').toLowerCase()
}

function guarded(root: string, ref: string): string {
  const path = resolveInsideWithoutSymlinks(root, ref)
  if (path === null) throw new Error('Unsafe prompt index path')
  return path
}

function read(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function stamp(path: string): string {
  if (!existsSync(path)) return 'missing'
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile()) throw new Error('Expected a regular thread file')
  return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

/**
 * A disposable prompt-only projection. Run in the search worker: neither source
 * parsing nor SQLite scans belong on Electron's main/renderer event loops.
 * Files remain authoritative; no conversation fold or tool/blob read is needed.
 */
export class PromptSearchIndex {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async search(
    projectId: string,
    query: string,
    current: () => boolean = () => true,
  ): Promise<PromptSearchResult> {
    const project = resolveProjectDir(this.root, projectId)
    if (!existsSync(project)) return { matches: [], incomplete: false }
    const path = guarded(project, INDEX_FILE)
    for (const suffix of ['-wal', '-shm', '-journal']) guarded(project, INDEX_FILE + suffix)
    const db = this.open(path)
    let incomplete = false
    try {
      const seen = new Set<string>()
      for (const dir of readdirSync(project, { withFileTypes: true })) {
        // Give newer queries/cancellation an opportunity between threads.
        await setImmediate()
        if (!current()) return { matches: [], incomplete: false }
        if (!dir.isDirectory()) continue
        const threadDir = guarded(project, dir.name)
        const metaPath = guarded(threadDir, 'meta.json')
        if (!existsSync(metaPath)) continue
        seen.add(dir.name)
        try {
          // A history edit may temporarily replace several files; never cache
          // the intermediate state. Native writes trigger a subsequent refresh.
          if (existsSync(guarded(threadDir, 'history-edit-transaction.json')))
            throw new Error('History edit in progress')
          const meta = safeJsonParse(read(metaPath), metaDecoder)
          if (meta === null) throw new Error('Invalid thread metadata')
          if (meta.archivedAt !== undefined) {
            db.prepare('DELETE FROM threads WHERE id=?').run(dir.name)
            continue
          }
          const eventsPath = guarded(threadDir, 'events.jsonl')
          const signature = stamp(eventsPath)
          const cached = db
            .prepare('SELECT signature, prompts FROM threads WHERE id=?')
            .get(dir.name)
          if (cached?.['signature'] === signature) continue
          const old =
            typeof cached?.['prompts'] === 'string'
              ? safeJsonParse(cached['prompts'], rowDecoder)
              : null
          const previous = new Map((old ?? []).map((entry) => [entry.key, entry.text]))
          const prompts: Array<{ key: string; text: string }> = []
          const spine = signature === 'missing' ? [] : parseSpine(read(eventsPath))
          for (const line of spine) {
            if (line.role !== 'user' || (line.origin !== undefined && line.editedByUser !== true))
              continue
            const ref = line.content
            if (!ref.ref.startsWith('messages/')) throw new Error('Invalid prompt reference')
            const key = JSON.stringify([line.id, ref.ref, ref.sha256])
            let text = previous.get(key)
            if (text === undefined) {
              const raw = read(guarded(threadDir, ref.ref))
              const body = parseOkfMessage(raw)?.body
              if (body === undefined) throw new Error('Invalid prompt file')
              if (createHash('sha256').update(body, 'utf8').digest('hex') !== ref.sha256)
                throw new Error('Prompt integrity check failed')
              text = normalizePromptSearch(body)
            }
            prompts.push({ key, text })
          }
          if (
            stamp(eventsPath) !== signature ||
            existsSync(guarded(threadDir, 'history-edit-transaction.json'))
          )
            throw new Error('Thread changed during indexing')
          db.prepare('INSERT OR REPLACE INTO threads(id,signature,prompts) VALUES(?,?,?)').run(
            dir.name,
            signature,
            JSON.stringify(prompts),
          )
        } catch {
          incomplete = true
          // Failed/stale rows must not return old matches.
          db.prepare('DELETE FROM threads WHERE id=?').run(dir.name)
        }
      }
      for (const row of db.prepare('SELECT id FROM threads').all()) {
        const id = row['id']
        if (typeof id === 'string' && !seen.has(id))
          db.prepare('DELETE FROM threads WHERE id=?').run(id)
      }
      if (!current() || query.length < 2) return { matches: [], incomplete }
      // instr preserves literal substring semantics, including two-character
      // searches and punctuation. Only normalized human prompt text is scanned.
      const matches = db
        .prepare(
          "SELECT id FROM threads WHERE EXISTS (SELECT 1 FROM json_each(prompts) WHERE instr(json_extract(value,'$.text'), ?) > 0)",
        )
        .all(normalizePromptSearch(query))
        .flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : []))
      return { matches, incomplete }
    } finally {
      db.close()
    }
  }

  private open(path: string): DatabaseSync {
    mkdirSync(dirname(path), { recursive: true })
    const open = (): DatabaseSync => {
      const db = new DatabaseSync(path)
      try {
        const version = db.prepare('PRAGMA user_version').get()?.['user_version']
        if (version !== 0 && version !== 1) throw new Error('Incompatible prompt index')
        db.exec(
          'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, signature TEXT NOT NULL, prompts TEXT NOT NULL); PRAGMA user_version=1;',
        )
        return db
      } catch (error) {
        db.close()
        throw error
      }
    }
    try {
      return open()
    } catch {
      // The guarded, derived cache is disposable. Never remove source files.
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true })
      return open()
    }
  }
}
