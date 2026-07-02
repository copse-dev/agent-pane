import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '@shared/types'
import { sortThreadsNewestFirst } from '@shared/store/thread-helpers.ts'
import { storageGet, storageDelete } from './storage.ts'
import { runSerialized } from './write-queue.ts'

const LEGACY_THREADS_PREFIX = 'threads:'

/** Mirrors `app-init.ts` userData resolution without requiring Electron in unit tests. */
function userDataDir(): string {
  const override = process.env['COPSE_PANEL_USER_DATA']?.trim()
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'copse-panel')
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'copse-panel')
  }
  return join(homedir(), '.config', 'copse-panel')
}

function projectThreadsDir(projectId: string): string {
  return join(userDataDir(), 'threads', projectId)
}

function threadFilePath(projectId: string, threadId: string): string {
  return join(projectThreadsDir(projectId), `${threadId}.json`)
}

function isValidThread(raw: unknown): raw is Thread {
  return typeof raw === 'object' && raw !== null && typeof (raw as Thread).id === 'string'
}

function parseThreadFile(raw: string): Thread | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isValidThread(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeThreadFile(projectId: string, thread: Thread): void {
  const dir = projectThreadsDir(projectId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(threadFilePath(projectId, thread.id), `${JSON.stringify(thread)}\n`)
}

function readProjectThreadFiles(projectId: string): Thread[] {
  const dir = projectThreadsDir(projectId)
  if (!existsSync(dir)) return []
  const threads: Thread[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const raw = readFileSync(join(dir, entry), 'utf8')
    const thread = parseThreadFile(raw)
    if (thread) threads.push(thread)
  }
  return sortThreadsNewestFirst(threads)
}

function migrateLegacyProjectThreads(projectId: string): Thread[] {
  const legacyKey = `${LEGACY_THREADS_PREFIX}${projectId}`
  const raw = storageGet(legacyKey)
  if (raw === undefined) return readProjectThreadFiles(projectId)

  const legacyThreads: Thread[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isValidThread(item)) legacyThreads.push(item)
    }
  }

  if (legacyThreads.length > 0) {
    const dir = projectThreadsDir(projectId)
    mkdirSync(dir, { recursive: true })
    for (const thread of legacyThreads) {
      writeThreadFile(projectId, thread)
    }
  }

  storageDelete(legacyKey)
  return legacyThreads.length > 0
    ? sortThreadsNewestFirst(legacyThreads)
    : readProjectThreadFiles(projectId)
}

const queueKey = (projectId: string): string => `thread-persistence:${projectId}`

export function loadProjectThreads(projectId: string): Promise<Thread[]> {
  return runSerialized(queueKey(projectId), () => migrateLegacyProjectThreads(projectId))
}

export function saveProjectThread(projectId: string, thread: Thread): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    writeThreadFile(projectId, thread)
  })
}

export function saveProjectThreads(projectId: string, threads: Thread[]): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const dir = projectThreadsDir(projectId)
    mkdirSync(dir, { recursive: true })
    const keepIds = new Set<string>()
    for (const thread of threads) {
      keepIds.add(thread.id)
      writeThreadFile(projectId, thread)
    }
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue
      const threadId = entry.slice(0, -'.json'.length)
      if (!keepIds.has(threadId)) {
        unlinkSync(join(dir, entry))
      }
    }
  })
}

export function deleteProjectThread(projectId: string, threadId: string): Promise<void> {
  return runSerialized(queueKey(projectId), () => {
    const file = threadFilePath(projectId, threadId)
    if (existsSync(file)) unlinkSync(file)
  })
}

/** Load every thread across all projects (usage summaries, etc.). */
export function loadAllProjectThreads(): Thread[] {
  const projects =
    (storageGet('projects') as Array<{ id: string }> | null)?.filter(
      (p) => typeof p.id === 'string' && p.id.length > 0,
    ) ?? []
  const threads: Thread[] = []
  for (const project of projects) {
    threads.push(...migrateLegacyProjectThreads(project.id))
  }
  return threads
}
