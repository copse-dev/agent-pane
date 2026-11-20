// Stable names and source paths for `node --test` reporter events.
import { realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The source path of a bundled test entry, relative to the run's output root.
 * Entries mirror source paths under a per-run scratch dir as `.test.mjs`.
 */
export function testEntryPath(root: string, file: string): string {
  return relative(canonicalPath(root), canonicalPath(file))
    .replaceAll('\\', '/')
    .replace(/\.mjs$/, '.ts')
}

/** Full `suite > test` names, built from `test:start` events as they arrive. */
export class TestNames {
  readonly #names = new Map<string, string>()
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  /** Record a started test; the file-level test is named by its source path. */
  start(file: string, testId: number, parentId: number | undefined, name: string): void {
    const stableName = name === file ? testEntryPath(this.#root, file) : name
    const parent = this.#names.get(`${file}:${String(parentId)}`)
    this.#names.set(`${file}:${String(testId)}`, parent ? `${parent} > ${stableName}` : stableName)
  }

  get(file: string, testId: number | undefined): string | undefined {
    return this.#names.get(`${file}:${String(testId)}`)
  }
}
