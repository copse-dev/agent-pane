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

const descriptor = JSON.parse(
  readFileSync('benchmarks/skillsbench/dataset-v1.1.json', 'utf8'),
) as Descriptor

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
