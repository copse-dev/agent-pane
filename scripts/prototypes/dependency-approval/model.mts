import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { load, JSON_SCHEMA } from 'js-yaml'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

const strings = z.record(z.string(), z.string())
const snapshotSchema = z.object({ digest: z.string(), files: strings, packages: strings })
const lockSchema = z
  .object({
    lockfileVersion: z.union([z.literal('9.0'), z.literal(9)]),
    importers: z.record(z.string(), z.unknown()),
    packages: z.record(z.string(), z.unknown()).default({}),
  })
  .loose()
/** Host-resolved project identity; thread and root are audit provenance only. */
export interface Scope {
  project: string
  thread: string
  root: string
}
type Snapshot = z.infer<typeof snapshotSchema>
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Input is a complete immutable staging manifest supplied by a trusted collector.
 * Hash every byte, including config, manifests, patches and local package contents.
 * Do not pass an agent-selected subset of the workspace here.
 */
export function snapshot(inputs: Readonly<Record<string, string>>): Snapshot {
  if (!Object.hasOwn(inputs, 'package.json') || !Object.hasOwn(inputs, 'pnpm-lock.yaml')) {
    throw new Error('package.json and pnpm-lock.yaml are required')
  }
  const lock = lockSchema.parse(
    load(z.string().parse(inputs['pnpm-lock.yaml']), { schema: JSON_SCHEMA }),
  )
  const files = Object.fromEntries(
    Object.entries(inputs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, contents]) => {
        if (
          path.startsWith('/') ||
          path.includes('\\') ||
          path.split('/').some((p) => !p || p === '.' || p === '..')
        ) {
          throw new Error('Inputs must use normalized relative paths')
        }
        return [path, hash(contents)]
      }),
  )
  const packages = Object.fromEntries(
    Object.entries(lock.packages)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, metadata]) => [name, hash(JSON.stringify(metadata))]),
  )
  return { digest: hash(JSON.stringify(['pnpm-isolated-v1', files])), files, packages }
}

interface Changes {
  added: string[]
  removed: string[]
  changed: string[]
}
const approvalSchema = z.object({
  thread: z.string(),
  root: z.string(),
  approvedAt: z.number(),
})
type Approval = z.infer<typeof approvalSchema>
interface Review {
  approval: Approval | null
  baselineDigest: string | null
  status: 'approved' | 'needs-approval'
  digest: string
  packages: Changes
  files: Changes
  scripts: string
}
interface Phase {
  argv: string[]
  network: string
  inputs: string
}
interface InstallPlan {
  digest: string
  executable: string
  fetch: Phase
  install: Phase
  lifecycleScripts: string
  executableHere: false
}

function changes(before: Record<string, string>, after: Record<string, string>): Changes {
  return {
    added: Object.keys(after)
      .filter((k) => !Object.hasOwn(before, k))
      .sort(),
    removed: Object.keys(before)
      .filter((k) => !Object.hasOwn(after, k))
      .sort(),
    changed: Object.keys(after)
      .filter((k) => Object.hasOwn(before, k) && before[k] !== after[k])
      .sort(),
  }
}

/** Host-owned database: never expose its path as writable to the agent/sandbox. */
export class DependencyApprovals {
  private readonly db: DatabaseSync
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS project_dependency_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL, digest TEXT NOT NULL, snapshot TEXT NOT NULL,
        provenance TEXT NOT NULL, UNIQUE(project, digest)
      )`,
    )
  }
  close(): void {
    this.db.close()
  }
  private project(scope: Scope): string {
    return z.string().min(1).parse(scope.project)
  }
  private previous(
    scope: Scope,
    digest: string,
  ): { snapshot: Snapshot; approval: Approval } | undefined {
    // Prefer an exact historical approval; otherwise compare with the latest approval.
    // Legacy thread-scoped rows are intentionally not read or promoted.
    const row = this.db
      .prepare(`SELECT snapshot, provenance FROM project_dependency_approvals
      WHERE project = ? ORDER BY (digest = ?) DESC, id DESC LIMIT 1`)
      .get(this.project(scope), digest)
    if (!row) return undefined
    const parsed = safeJsonParse(
      z.string().parse(row['snapshot']),
      decodeWithSchema(snapshotSchema),
    )
    const approval = safeJsonParse(
      z.string().parse(row['provenance']),
      decodeWithSchema(approvalSchema),
    )
    if (!parsed || !approval) throw new Error('Invalid approval state')
    return { snapshot: parsed, approval }
  }
  review(scope: Scope, inputs: Readonly<Record<string, string>>): Review {
    const current = snapshot(inputs)
    const previous = this.previous(scope, current.digest)
    const approved = previous?.snapshot.digest === current.digest
    return {
      status: approved ? 'approved' : 'needs-approval',
      approval: approved ? previous.approval : null,
      baselineDigest: previous?.snapshot.digest ?? null,
      digest: current.digest,
      packages: changes(previous?.snapshot.packages ?? {}, current.packages),
      files: changes(previous?.snapshot.files ?? {}, current.files),
      scripts: 'disabled; lockfile metadata cannot enumerate all dependency lifecycle scripts',
    }
  }
  /** Call only from a host approval action, with the digest actually shown to the user.
   * Re-capture inputs before calling; a stale dialog cannot approve a newer snapshot.
   */
  approve(scope: Scope, reviewedDigest: string, inputs: Readonly<Record<string, string>>): void {
    const current = snapshot(inputs)
    if (current.digest !== reviewedDigest) throw new Error('Inputs changed since review')
    this.db
      .prepare(`INSERT INTO project_dependency_approvals (project, digest, snapshot, provenance)
        VALUES (?, ?, ?, ?) ON CONFLICT(project, digest) DO NOTHING`)
      .run(
        this.project(scope),
        current.digest,
        JSON.stringify(current),
        JSON.stringify({
          thread: z.string().min(1).parse(scope.thread),
          root: z.string().min(1).parse(scope.root),
          approvedAt: Date.now(),
        }),
      )
  }
  plan(scope: Scope, command: string, inputs: Readonly<Record<string, string>>): InstallPlan {
    if (!/^pnpm install(?: --frozen-lockfile)?$/.test(command)) {
      throw new Error('Only plain pnpm install is supported; resolve additions separately')
    }
    const review = this.review(scope, inputs)
    if (review.status !== 'approved') throw new Error('Dependency approval required')
    // This is deliberately a plan, never shell execution or an authorization to run unsandboxed.
    return {
      digest: review.digest,
      executable: 'host-pinned pnpm',
      fetch: {
        argv: ['fetch', '--frozen-lockfile', '--ignore-scripts'],
        network: 'broker allows only approved integrity-bound artifact requests',
        inputs: 'immutable approved lockfile; no workspace, user config, hooks or credentials',
      },
      install: {
        argv: [
          'install',
          '--offline',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--ignore-pnpmfile',
        ],
        network: 'kernel-denied, including DNS and host/proxy sockets',
        inputs: 'immutable approved staging tree and verified private store; clean environment',
      },
      lifecycleScripts: 'require separate capability approval and a networkless build sandbox',
      executableHere: false,
    }
  }
}
