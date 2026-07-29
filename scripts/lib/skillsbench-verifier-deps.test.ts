import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

interface DepEntry {
  uv: string[]
  uvxWith: string[]
  pip: string[]
  /** Packages upstream left unpinned; staged at whatever version build time resolves. */
  pipUnpinned: string[]
  apt: string[]
}

interface Inventory {
  schemaVersion: number
  datasetRevision: string
  union: DepEntry
  tasks: Record<string, DepEntry>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isDepEntry(value: unknown): value is DepEntry {
  if (!isRecord(value)) return false
  return (
    isStringArray(value['uv']) &&
    isStringArray(value['uvxWith']) &&
    isStringArray(value['pip']) &&
    isStringArray(value['pipUnpinned']) &&
    isStringArray(value['apt'])
  )
}

function isInventory(value: unknown): value is Inventory {
  if (!isRecord(value)) return false
  if (typeof value['schemaVersion'] !== 'number') return false
  if (typeof value['datasetRevision'] !== 'string') return false
  if (!isDepEntry(value['union'])) return false
  const tasks = value['tasks']
  if (!isRecord(tasks)) return false
  return Object.values(tasks).every(isDepEntry)
}

function loadInventory(): Inventory {
  const parsed: unknown = JSON.parse(
    readFileSync('benchmarks/skillsbench/verifier-deps.json', 'utf8'),
  )
  if (!isInventory(parsed)) throw new Error('verifier-deps.json is malformed')
  return parsed
}

function loadDatasetRevisionAndTasks(): { revision: string; active: Set<string> } {
  const parsed: unknown = JSON.parse(
    readFileSync('benchmarks/skillsbench/dataset-v1.1.json', 'utf8'),
  )
  if (!isRecord(parsed)) throw new Error('dataset descriptor is malformed')
  const dataset = parsed['dataset']
  const active = parsed['active']
  if (!isRecord(dataset) || typeof dataset['revision'] !== 'string') {
    throw new Error('dataset descriptor is missing a revision')
  }
  if (!Array.isArray(active)) throw new Error('dataset descriptor is missing active tasks')
  const names = new Set<string>()
  for (const task of active) {
    if (isRecord(task) && typeof task['name'] === 'string') names.add(task['name'])
  }
  return { revision: dataset['revision'], active: names }
}

const inventory = loadInventory()
const descriptor = loadDatasetRevisionAndTasks()

const PINNED = /^[A-Za-z][A-Za-z0-9_.[\]-]*==[0-9][^\s]*$/

describe('SkillsBench verifier dependency inventory', () => {
  it('is pinned to the same dataset revision as the task descriptor', () => {
    assert.equal(inventory.schemaVersion, 2)
    assert.equal(inventory.datasetRevision, descriptor.revision)
  })

  it('only names tasks that exist in the pinned descriptor', () => {
    const unknown = Object.keys(inventory.tasks).filter((name) => !descriptor.active.has(name))
    assert.deepEqual(unknown, [])
  })

  it('pins every Python dependency to an exact version', () => {
    // An unpinned dependency would resolve differently at build time than the
    // verifier asks for at grading time, so the warmed cache would miss and the
    // offline resolve would fail — silently scoring the task zero again.
    for (const [task, entry] of Object.entries(inventory.tasks)) {
      for (const spec of [...entry.uvxWith, ...entry.pip]) {
        assert.match(spec, PINNED, `${task}: '${spec}' is not pinned to an exact version`)
      }
      for (const version of entry.uv) {
        assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+$/, `${task}: uv '${version}' is not pinned`)
      }
    }
  })

  it('keeps unpinned entries to bare package names', () => {
    // A flag or a pin leaking into pipUnpinned would either break the build or
    // silently double-install; both are worse than the miss they replaced.
    for (const [task, entry] of Object.entries(inventory.tasks)) {
      for (const pkg of entry.pipUnpinned) {
        assert.match(pkg, /^[A-Za-z][A-Za-z0-9_.[\]-]*$/, `${task}: '${pkg}' is not a bare name`)
        assert.ok(!pkg.includes('=='), `${task}: '${pkg}' is pinned and belongs in pip`)
      }
    }
  })

  it('carries no shell-construct artefacts in the apt lists', () => {
    // The inventory is extracted by parsing shell; keywords leaking into the
    // package list would make the pre-bake layer fail the image build.
    const keywords = new Set(['if', 'then', 'else', 'fi', 'command', 'do', 'done'])
    for (const [task, entry] of Object.entries(inventory.tasks)) {
      for (const pkg of entry.apt) {
        assert.ok(!keywords.has(pkg), `${task}: '${pkg}' is a shell keyword, not a package`)
        assert.match(pkg, /^[a-z0-9][a-z0-9.+-]*$/, `${task}: '${pkg}' is not a package name`)
      }
    }
  })

  it('records a non-empty need for every listed task', () => {
    // A task with an entry but nothing to stage would produce an empty layer
    // while still marking the capsule as pre-baked.
    for (const [task, entry] of Object.entries(inventory.tasks)) {
      const total =
        entry.uv.length +
        entry.uvxWith.length +
        entry.pip.length +
        entry.pipUnpinned.length +
        entry.apt.length
      assert.ok(total > 0, `${task}: listed but stages nothing`)
    }
  })

  it('leaves the self-contained verifiers out entirely', () => {
    // bike-rebalance is the task the live oracle sweep scored 1.0 under
    // no-network; its verifier installs nothing, so it must stay untouched and
    // keep a byte-identical image.
    assert.ok(!Object.hasOwn(inventory.tasks, 'bike-rebalance'))
  })
})
