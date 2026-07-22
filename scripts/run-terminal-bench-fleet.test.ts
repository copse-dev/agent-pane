import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { cleanPrefix, registryHost, runConfig } from './run-terminal-bench-fleet.mts'

const workerImage = 'rg.fr-par.scw.cloud/example/terminal-bench-worker:abc123'

test('Scaleway workflow defaults to a Serverless model ID', () => {
  const workflow = readFileSync('.github/workflows/terminal-bench-scaleway.yml', 'utf8')
  assert.match(workflow, /default: qwen3\.6-35b-a3b/)
  assert.doesNotMatch(workflow, /qwen\/qwen3\.6-35b-a3b:(?:fp8|bf16)/)
})

test('Scaleway workflow probes Object Storage with PutObject, not HeadBucket', () => {
  const workflow = readFileSync('.github/workflows/terminal-bench-scaleway.yml', 'utf8')
  assert.doesNotMatch(workflow, /head-bucket/)
  assert.match(workflow, /aws s3 cp - "s3:\/\/\$\{BUCKET\}\/\$\{probe_key\}"/)
  assert.match(workflow, /--sse AES256/)
  assert.match(workflow, /terminal-bench\/_github_preflight\//)
})

test('fleet limits workers to the number of selected tasks', () => {
  const config = runConfig({ instances: '10', 'max-tasks': '3', 'worker-image': workerImage })
  assert.equal(config.instanceCount, 3)
  assert.equal(config.maxTasks, 3)
})

test('fleet requires a zone for zonal Scaleway resources', () => {
  assert.throws(
    () => runConfig({ 'security-group-id': 'sg-id', 'worker-image': workerImage }),
    /security-group-id is zone-specific/,
  )
  assert.throws(
    () =>
      runConfig({
        'scw-image': '00000000-1111-2222-3333-444444444444',
        'worker-image': workerImage,
      }),
    /custom Scaleway image ID is zone-specific/,
  )

  const config = runConfig({
    'security-group-id': 'sg-id',
    'worker-image': workerImage,
    zone: 'fr-par-1',
  })
  assert.deepEqual(config.zones, ['fr-par-1'])
})

test('fleet normalizes object prefixes and accepts fully qualified registry hosts', () => {
  assert.equal(cleanPrefix('/terminal-bench/run/'), 'terminal-bench/run')
  assert.equal(registryHost(workerImage), 'rg.fr-par.scw.cloud')
  assert.throws(() => registryHost('ubuntu/worker:latest'), /registry host 'ubuntu' is invalid/)
})
