import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  parseSupervisedTaskMeta,
  serializeSupervisedTaskAuditEvent,
  supervisedTaskAuditEventSchema,
  supervisedTaskMetaSchema,
  type SupervisedTaskAuditEvent,
  type SupervisedTaskMeta,
} from '@shared/supervisor/task-schema.ts'
import { copseWorkspaceDir, projectStoreDir } from '../storage/copse-paths.ts'
import { runSerialized } from '../storage/write-queue.ts'

const TASKS_DIR = 'tasks'
const META_FILE = 'meta.json'
const AUDIT_FILE = 'audit.jsonl'

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
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function containedTaskDir(projectId: string, taskId: string, env: NodeJS.ProcessEnv): string {
  const root = resolve(projectStoreDir(projectId, env), TASKS_DIR)
  const candidate = resolve(root, taskId)
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Task id resolves outside the project task store')
  }
  return candidate
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
