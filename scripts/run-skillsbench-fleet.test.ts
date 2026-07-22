import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { skillsBenchFleetConfig, skillsBenchWorkerEnvironment } from './run-skillsbench-fleet.mts'

const workerImage = 'rg.fr-par.scw.cloud/copse/skillsbench:abc123'

describe('SkillsBench Scaleway spike', () => {
  it('requires an explicit profile and caps workers by selected tasks', () => {
    assert.throws(() => skillsBenchFleetConfig({ 'worker-image': workerImage }), /profile/)
    const config = skillsBenchFleetConfig({
      'worker-image': workerImage,
      profile: 'skills-product',
      instances: '8',
      'task-names': 'offer-letter-generator,xlsx-recover-data',
    })
    assert.equal(config.instanceCount, 2)
    assert.equal(config.profile, 'skills-product')
  })

  it('passes immutable treatment and runner provenance to each shard', () => {
    const values = {
      SCW_GENERATIVE_API_KEY: 'model-secret',
      LM_STUDIO_MODEL: 'qwen3.6-35b-a3b',
      SCW_OBJECT_STORAGE_ACCESS_KEY_ID: 'object-key',
      SCW_OBJECT_STORAGE_SECRET_KEY: 'object-secret',
      SCW_OBJECT_STORAGE_BUCKET: 'capsules',
    }
    const previous = Object.fromEntries(
      Object.keys(values).map((name) => [name, process.env[name]]),
    )
    Object.assign(process.env, values)
    try {
      const config = skillsBenchFleetConfig({
        'worker-image': workerImage,
        profile: 'skills-none',
      })
      const environment = skillsBenchWorkerEnvironment(config, 0)
      assert.match(environment, /^COPSE_SKILLSBENCH_PROFILE=skills-none$/m)
      assert.match(environment, new RegExp(`^COPSE_SKILLSBENCH_WORKER_IMAGE=${workerImage}$`, 'm'))
      assert.match(environment, /^COPSE_SKILLSBENCH_TASK_NAMES=offer-letter-generator$/m)
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
    }
  })

  it('workflow builds the pinned SkillsBench worker and always tears down', () => {
    const workflow = readFileSync('.github/workflows/skillsbench-scaleway-spike.yml', 'utf8')
    assert.match(workflow, /benchmarks\/skillsbench\/Dockerfile\.worker/)
    assert.match(workflow, /if: always\(\)/)
    assert.match(workflow, /bench:skills:fleet/)
  })
})
