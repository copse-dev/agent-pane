import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { copseDataRoot } from '../storage/copse-paths.ts'
import {
  discoverPackToolSource,
  type PackToolSourceCandidate,
  PackToolSourceError,
} from './pack-tool-source.ts'

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules'])
const SKIPPED_FILES = new Set(['.DS_Store'])

function snapshotRoot(): string {
  const override = process.env['COPSE_PACK_TOOL_SNAPSHOT_DIR']?.trim()
  return override && override.length > 0 ? override : join(copseDataRoot(), 'pack-tool-snapshots')
}

function packDirectoryName(packId: string): string {
  return createHash('sha256').update(packId).digest('hex').slice(0, 24)
}

async function copyReviewedTree(source: string, destination: string): Promise<void> {
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 })
  const entries = await fsp.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue
    if (entry.isFile() && SKIPPED_FILES.has(entry.name)) continue
    const sourcePath = join(source, entry.name)
    const destinationPath = join(destination, entry.name)
    if (entry.isSymbolicLink()) {
      throw new PackToolSourceError(
        `Pack contains a symbolic link while snapshotting: ${entry.name}`,
      )
    }
    if (entry.isDirectory()) {
      await copyReviewedTree(sourcePath, destinationPath)
      continue
    }
    if (!entry.isFile()) {
      throw new PackToolSourceError(
        `Pack contains an unsupported file while snapshotting: ${entry.name}`,
      )
    }
    await fsp.copyFile(sourcePath, destinationPath)
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isExactSnapshot(
  source: PackToolSourceCandidate,
  snapshot: PackToolSourceCandidate,
): boolean {
  return (
    snapshot.manifest.name === source.manifest.name &&
    snapshot.contentHash === source.contentHash &&
    snapshot.runtime.entrypoint === source.runtime.entrypoint &&
    sameStrings(snapshot.manifest.tools?.provides ?? [], source.manifest.tools?.provides ?? []) &&
    sameStrings(
      snapshot.manifest.models?.provides.map((route) => route.id) ?? [],
      source.manifest.models?.provides.map((route) => route.id) ?? [],
    )
  )
}

async function validateSnapshot(
  source: PackToolSourceCandidate,
  path: string,
): Promise<PackToolSourceCandidate> {
  const snapshot = await discoverPackToolSource(path)
  if (!isExactSnapshot(source, snapshot)) {
    throw new PackToolSourceError('Pack tool snapshot does not match the selected source content.')
  }
  return snapshot
}

/**
 * Copy the reviewed bytes into a Copse-owned content-addressed directory.
 * Unhashed development directories never enter the executable snapshot, and
 * the copied tree is re-hashed before it can be launched.
 */
export async function materializePackToolSnapshot(
  source: PackToolSourceCandidate,
  root = snapshotRoot(),
): Promise<PackToolSourceCandidate> {
  const hash = source.contentHash.slice('sha256:'.length)
  const parent = join(root, packDirectoryName(source.manifest.name))
  const destination = join(parent, hash)
  const existing = await fsp.stat(destination).catch(() => null)
  if (existing) {
    if (!existing.isDirectory()) {
      throw new PackToolSourceError('Pack tool snapshot path is not a directory.')
    }
    return await validateSnapshot(source, destination)
  }

  await fsp.mkdir(parent, { recursive: true, mode: 0o700 })
  const staging = await fsp.mkdtemp(join(parent, '.staging-'))
  try {
    await copyReviewedTree(source.sourcePath, staging)
    await validateSnapshot(source, staging)
    try {
      await fsp.rename(staging, destination)
    } catch (error) {
      const isExistingDestination =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
      if (!isExistingDestination) throw error
      await fsp.rm(staging, { recursive: true, force: true })
    }
    return await validateSnapshot(source, destination)
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
