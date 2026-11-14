import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export class ProjectCreationPathError extends Error {}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return undefined
  return Object.getOwnPropertyDescriptor(error, 'code')?.value
}

async function prospectiveDirectory(path: string): Promise<string> {
  let probe = resolve(path)
  const missing: string[] = []
  for (;;) {
    const existing = await lstat(probe).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    })
    if (existing) {
      const canonical = await realpath(probe)
      if (!(await stat(canonical)).isDirectory()) {
        throw new ProjectCreationPathError('Project parent must be a folder')
      }
      return resolve(canonical, ...missing)
    }
    const parent = dirname(probe)
    if (parent === probe) throw new ProjectCreationPathError('Project parent does not exist')
    missing.unshift(basename(probe))
    probe = parent
  }
}

async function projectTarget(path: string): Promise<'missing' | 'empty'> {
  const target = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  })
  if (!target) return 'missing'
  if (target.isSymbolicLink()) {
    throw new ProjectCreationPathError('Target folder must not be a symbolic link')
  }
  if (!target.isDirectory()) {
    throw new ProjectCreationPathError('Target exists and is not a folder')
  }
  if ((await realpath(path)) !== path) {
    throw new ProjectCreationPathError('Project path changed after confirmation')
  }
  if ((await readdir(path)).length > 0) {
    throw new ProjectCreationPathError('Folder already exists and is not empty')
  }
  return 'empty'
}

export async function prepareProjectCreation(input: {
  parentDir: string
  name: string
  confirm: (projectPath: string) => Promise<boolean>
}): Promise<{ projectPath: string; projectMissing: boolean }> {
  const requestedPath = join(input.parentDir, input.name)
  if (
    resolve(input.parentDir, input.name) !== requestedPath ||
    basename(requestedPath) !== input.name
  ) {
    throw new ProjectCreationPathError('Invalid project name')
  }

  const projectPath = join(await prospectiveDirectory(input.parentDir), input.name)
  if (!(await input.confirm(projectPath))) {
    throw new ProjectCreationPathError('Project creation was not confirmed')
  }

  const revalidatedPath = join(await prospectiveDirectory(input.parentDir), input.name)
  if (revalidatedPath !== projectPath) {
    throw new ProjectCreationPathError('Project path changed after confirmation')
  }

  const projectMissing = (await projectTarget(projectPath)) === 'missing'
  if (projectMissing) await mkdir(projectPath, { recursive: true })
  if ((await realpath(projectPath)) !== projectPath) {
    throw new ProjectCreationPathError('Project path changed after confirmation')
  }
  const created = await lstat(projectPath)
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new ProjectCreationPathError('Target is not a stable project folder')
  }
  if (projectMissing && (await readdir(projectPath)).length > 0) {
    throw new ProjectCreationPathError('New project folder is not empty')
  }
  return { projectPath, projectMissing }
}
