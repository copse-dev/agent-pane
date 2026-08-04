import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  parseSupervisedTaskMeta,
  serializeSupervisedTaskAuditEvent,
  supervisedTaskArchiveSchema,
  supervisedTaskAuditEventSchema,
  supervisedTaskMetaSchema,
  type SupervisedTaskArchive,
  type SupervisedTaskAuditEvent,
  type SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import { copseWorkspaceDir, projectStoreDir } from '../storage/copse-paths.ts'
import { runSerialized } from '../storage/write-queue.ts'

const TASKS_DIR = 'tasks'
const META_FILE = 'meta.json'
const AUDIT_FILE = 'audit.jsonl'
const ARCHIVE_DIR = 'task-history'

export interface TaskLoadDiagnostic {
  path: string
  reason: string
}

export interface LoadedSupervisedTasks {
  tasks: SupervisedTaskMeta[]
  diagnostics: TaskLoadDiagnostic[]
}

export interface SupervisedTaskStore {
  loadAll(): Promise<LoadedSupervisedTasks>
  loadProject(projectId: string): Promise<LoadedSupervisedTasks>
  get(projectId: string, taskId: string): Promise<SupervisedTaskMeta | null>
  saveTransition(meta: SupervisedTaskMeta, audit: SupervisedTaskAuditEvent): Promise<void>
  compactTerminalTasks(before: number): Promise<number>
  loadTaskArchive(projectId: string): Promise<SupervisedTaskArchive[]>
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function containedTaskDir(projectId: string, taskId: string, env: NodeJS.ProcessEnv): string {
  if (taskId.includes('/') || taskId.includes('\\')) {
    throw new Error('Task id must not contain path separators')
  }
  const root = resolve(projectStoreDir(projectId, env), TASKS_DIR)
  const candidate = resolve(root, taskId)
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Task id resolves outside the project task store')
  }
  return candidate
}

function containedArchivePath(projectId: string, taskId: string, env: NodeJS.ProcessEnv): string {
  if (taskId.includes('/') || taskId.includes('\\')) {
    throw new Error('Task id must not contain path separators')
  }
  const root = resolve(projectStoreDir(projectId, env), ARCHIVE_DIR)
  const candidate = resolve(root, `${taskId}.json`)
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Task id resolves outside the project task archive')
  }
  return candidate
}

function archiveTask(task: SupervisedTaskMeta): SupervisedTaskArchive | null {
  if (task.state !== 'cancelled' && task.state !== 'failed' && task.state !== 'completed') {
    return null
  }
  return supervisedTaskArchiveSchema.parse({
    v: 1,
    taskId: task.taskId,
    projectId: task.projectId,
    threadId: task.threadId,
    handler: task.handler,
    provenance: task.provenance,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    attempt: task.attempt,
    ...(task.lastError ? { lastError: task.lastError } : {}),
    ...(task.resultRef ? { resultRef: task.resultRef } : {}),
  })
}

function atomicWrite(path: string, data: string): void {
  const temporary = `${path}.copse-${String(process.pid)}-${randomUUID()}.tmp`
  writeFileSync(temporary, data, 'utf8')
  renameSync(temporary, path)
}

function queueKey(projectId: string, taskId: string): string {
  return `supervised-task:${projectId}:${taskId}`
}

export class FileSupervisedTaskStore implements SupervisedTaskStore {
  private readonly env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env
  }

  loadAll(): Promise<LoadedSupervisedTasks> {
    return runSerialized('supervised-tasks:load-all', () => {
      const root = copseWorkspaceDir(this.env)
      if (!existsSync(root)) return { tasks: [], diagnostics: [] }
      const projects = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      const loaded = projects.map((projectId) => this.loadProjectSync(projectId))
      return {
        tasks: loaded.flatMap((result) => result.tasks),
        diagnostics: loaded.flatMap((result) => result.diagnostics),
      }
    })
  }

  loadProject(projectId: string): Promise<LoadedSupervisedTasks> {
    return runSerialized(`supervised-tasks:load-project:${projectId}`, () =>
      this.loadProjectSync(projectId),
    )
  }

  get(projectId: string, taskId: string): Promise<SupervisedTaskMeta | null> {
    return runSerialized(queueKey(projectId, taskId), () => {
      const path = join(containedTaskDir(projectId, taskId, this.env), META_FILE)
      const raw = safeRead(path)
      if (raw === null) return null
      try {
        return parseSupervisedTaskMeta(JSON.parse(raw) as unknown)
      } catch {
        return null
      }
    })
  }

  saveTransition(meta: SupervisedTaskMeta, audit: SupervisedTaskAuditEvent): Promise<void> {
    const validatedMeta = supervisedTaskMetaSchema.parse(meta)
    const validatedAudit = supervisedTaskAuditEventSchema.parse(audit)
    if (
      validatedAudit.taskId !== validatedMeta.taskId ||
      validatedAudit.toState !== validatedMeta.state
    ) {
      return Promise.reject(new Error('Task transition audit does not match task metadata'))
    }
    return runSerialized(queueKey(meta.projectId, meta.taskId), () => {
      const dir = containedTaskDir(meta.projectId, meta.taskId, this.env)
      mkdirSync(dir, { recursive: true })
      atomicWrite(join(dir, META_FILE), `${JSON.stringify(validatedMeta, null, 2)}\n`)
      appendFileSync(
        join(dir, AUDIT_FILE),
        `${serializeSupervisedTaskAuditEvent(validatedAudit)}\n`,
        'utf8',
      )
    })
  }

  compactTerminalTasks(before: number): Promise<number> {
    return runSerialized('supervised-tasks:compact', () => {
      const root = copseWorkspaceDir(this.env)
      if (!existsSync(root)) return 0
      let compacted = 0
      for (const project of readdirSync(root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        const loaded = this.loadProjectSync(project.name)
        for (const task of loaded.tasks) {
          if (task.updatedAt >= before) continue
          const archive = archiveTask(task)
          if (!archive) continue
          const archivePath = containedArchivePath(task.projectId, task.taskId, this.env)
          mkdirSync(join(projectStoreDir(task.projectId, this.env), ARCHIVE_DIR), {
            recursive: true,
          })
          atomicWrite(archivePath, `${JSON.stringify(archive, null, 2)}\n`)
          rmSync(containedTaskDir(task.projectId, task.taskId, this.env), {
            recursive: true,
            force: true,
          })
          compacted++
        }
      }
      return compacted
    })
  }

  loadTaskArchive(projectId: string): Promise<SupervisedTaskArchive[]> {
    return runSerialized(`supervised-tasks:archive:${projectId}`, () => {
      const root = join(projectStoreDir(projectId, this.env), ARCHIVE_DIR)
      if (!existsSync(root)) return []
      const archived: SupervisedTaskArchive[] = []
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const raw = safeRead(join(root, entry.name))
        if (raw === null) continue
        try {
          const parsed = supervisedTaskArchiveSchema.safeParse(JSON.parse(raw) as unknown)
          if (parsed.success && parsed.data.projectId === projectId) archived.push(parsed.data)
        } catch {
          // A corrupt support summary is isolated like a corrupt live task.
        }
      }
      return archived.sort((a, b) => b.updatedAt - a.updatedAt)
    })
  }

  private loadProjectSync(projectId: string): LoadedSupervisedTasks {
    const tasksRoot = join(projectStoreDir(projectId, this.env), TASKS_DIR)
    if (!existsSync(tasksRoot)) return { tasks: [], diagnostics: [] }
    const tasks: SupervisedTaskMeta[] = []
    const diagnostics: TaskLoadDiagnostic[] = []
    for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      let dir: string
      try {
        dir = containedTaskDir(projectId, entry.name, this.env)
      } catch (error) {
        diagnostics.push({
          path: join(tasksRoot, entry.name),
          reason: error instanceof Error ? error.message : 'invalid task path',
        })
        continue
      }
      const path = join(dir, META_FILE)
      const raw = safeRead(path)
      if (raw === null) {
        diagnostics.push({ path, reason: 'missing or unreadable meta.json' })
        continue
      }
      let decoded: unknown
      try {
        decoded = JSON.parse(raw) as unknown
      } catch {
        diagnostics.push({ path, reason: 'malformed meta.json' })
        continue
      }
      const task = parseSupervisedTaskMeta(decoded)
      if (!task || task.projectId !== projectId || task.taskId !== entry.name) {
        diagnostics.push({ path, reason: 'task metadata does not match its store path' })
        continue
      }
      tasks.push(task)
    }
    return { tasks, diagnostics }
  }
}
