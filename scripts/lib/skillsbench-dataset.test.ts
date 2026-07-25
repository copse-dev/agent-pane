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

function stringProperty(value: unknown, key: string): string {
  if (!isRecord(value)) throw new Error('Invalid SkillsBench descriptor.')
  const property = value[key]
  if (typeof property !== 'string' || !property) {
    throw new Error(`SkillsBench descriptor ${key} is invalid.`)
  }
  return property
}

function parseTask(value: unknown): TaskRecord {
  return {
    name: stringProperty(value, 'name'),
    git_commit_id: stringProperty(value, 'git_commit_id'),
    path: stringProperty(value, 'path'),
    digest: stringProperty(value, 'digest'),
  }
}

function parseExcluded(value: unknown): { name: string; reason: string } {
  return {
    name: stringProperty(value, 'name'),
    reason: stringProperty(value, 'reason'),
  }
}

function parseDescriptor(value: unknown): Descriptor {
  if (!isRecord(value)) throw new Error('SkillsBench descriptor was not an object.')
  const datasetValue = value['dataset']
  if (!isRecord(datasetValue)) throw new Error('SkillsBench descriptor dataset is invalid.')
  const activeRaw = value['active']
  const excludedRaw = value['excluded']
  if (!Array.isArray(activeRaw) || !Array.isArray(excludedRaw)) {
    throw new Error('SkillsBench descriptor task lists are invalid.')
  }
  return {
    dataset: {
      version: stringProperty(datasetValue, 'version'),
      revision: stringProperty(datasetValue, 'revision'),
      benchflow: stringProperty(datasetValue, 'benchflow'),
    },
    active: activeRaw.map(parseTask),
    excluded: excludedRaw.map(parseExcluded),
  }
}

const parsed: unknown = JSON.parse(readFileSync('benchmarks/skillsbench/dataset-v1.1.json', 'utf8'))
const descriptor = parseDescriptor(parsed)

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
