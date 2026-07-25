import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

interface TaskRecord {
  name: string
  git_commit_id: string
  path: string
  digest: string
}

interface Descriptor {
  dataset: { version: string; revision: string; benchflow: string }
  active: TaskRecord[]
  excluded: Array<{ name: string; reason: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isTaskRecord(value: unknown): value is TaskRecord {
  if (!isRecord(value)) return false
  return (
    isString(value['name']) &&
    isString(value['git_commit_id']) &&
    isString(value['path']) &&
    isString(value['digest'])
  )
}

function isExcluded(value: unknown): value is { name: string; reason: string } {
  if (!isRecord(value)) return false
  return isString(value['name']) && isString(value['reason'])
}

function isDescriptor(value: unknown): value is Descriptor {
  if (!isRecord(value)) return false
  const dataset = value['dataset']
  if (!isRecord(dataset)) return false
  if (
    !isString(dataset['version']) ||
    !isString(dataset['revision']) ||
    !isString(dataset['benchflow'])
  ) {
    return false
  }
  const active = value['active']
  const excluded = value['excluded']
  if (!Array.isArray(active) || !Array.isArray(excluded)) return false
  return active.every(isTaskRecord) && excluded.every(isExcluded)
}

function loadDescriptor(): Descriptor {
  const parsed: unknown = JSON.parse(
    readFileSync('benchmarks/skillsbench/dataset-v1.1.json', 'utf8'),
  )
  if (!isDescriptor(parsed)) {
    throw new Error(
      'benchmarks/skillsbench/dataset-v1.1.json is not a valid SkillsBench descriptor',
    )
  }
  return parsed
}

const descriptor = loadDescriptor()

describe('SkillsBench v1.1 descriptor', () => {
  it('pins the release and BenchFlow compatibility point', () => {
    assert.equal(descriptor.dataset.version, '1.1')
    assert.equal(descriptor.dataset.revision, 'b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af')
    assert.equal(descriptor.dataset.benchflow, '0.6.3')
  })

  it('contains 87 unique active tasks and 14 explicit exclusions', () => {
    assert.equal(descriptor.active.length, 87)
    assert.equal(new Set(descriptor.active.map((task) => task.name)).size, 87)
    assert.equal(descriptor.excluded.length, 14)
    assert.equal(new Set(descriptor.excluded.map((task) => task.name)).size, 14)
  })

  it('retains immutable task revisions, paths, and digests', () => {
    for (const task of descriptor.active) {
      assert.match(task.git_commit_id, /^[0-9a-f]{40}$/)
      assert.equal(task.path, `tasks/${task.name}`)
      assert.match(task.digest, /^sha256:[0-9a-f]{64}$/)
    }
  })
})
