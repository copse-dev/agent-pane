import { z } from 'zod'
import { zProjectId } from './ipc-guards.ts'
import { workspaceRootKey, type WorkspaceProjectRef } from '../services/workspace.ts'

export const projectRootsSchema = z
  .array(
    z.looseObject({
      id: zProjectId,
      path: z.string().min(1).max(4096),
      sshHost: z.string().min(1).max(128).optional(),
    }),
  )
  .max(10_000)

/** Only newly named roots can widen the renderer's filesystem authority. */
export function newProjectRoots(current: unknown, proposed: unknown): WorkspaceProjectRef[] {
  const next = projectRootsSchema.parse(proposed)
  const previous = projectRootsSchema.safeParse(current)
  const existing = new Set(
    (previous.success ? previous.data : []).map((project) =>
      workspaceRootKey(project.path, project.sshHost),
    ),
  )
  const additions: WorkspaceProjectRef[] = []
  for (const project of next) {
    const key = workspaceRootKey(project.path, project.sshHost)
    if (existing.has(key)) continue
    existing.add(key)
    additions.push(
      project.sshHost ? { path: project.path, sshHost: project.sshHost } : { path: project.path },
    )
  }
  return additions
}

export async function authorizeProjectRoots(
  current: unknown,
  proposed: unknown,
  authority: {
    allowed: (project: WorkspaceProjectRef) => Promise<string>
    canonical: (project: WorkspaceProjectRef) => Promise<string>
    confirm: (project: WorkspaceProjectRef, canonical: string) => Promise<boolean>
    register: (project: WorkspaceProjectRef, canonical: string) => Promise<void>
  },
): Promise<z.infer<typeof projectRootsSchema>> {
  const projects = projectRootsSchema.parse(proposed)
  const canonicalByKey = new Map<string, string>()
  for (const project of newProjectRoots(current, projects)) {
    let canonical: string
    try {
      canonical = await authority.allowed(project)
    } catch {
      canonical = await authority.canonical(project)
      if (!(await authority.confirm(project, canonical))) {
        throw new Error('Project folder was not confirmed')
      }
      await authority.register(project, canonical)
    }
    canonicalByKey.set(workspaceRootKey(project.path, project.sshHost), canonical)
  }
  return projects.map((project) => {
    const canonical = canonicalByKey.get(workspaceRootKey(project.path, project.sshHost))
    return canonical ? { ...project, path: canonical } : project
  })
}
