import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  cleanPrefix,
  registryHost,
  runConfig,
  workerFollowRemoteScript,
} from './run-terminal-bench-fleet.mts'
import { rotateTerminalBenchProfiles } from './lib/terminal-bench-profiles.mts'

const workerImage = 'rg.fr-par.scw.cloud/example/terminal-bench-worker:abc123'

test('Scaleway workflow defaults to a Serverless model ID', () => {
  const workflow = readFileSync('.github/workflows/terminal-bench-scaleway.yml', 'utf8')
  assert.match(workflow, /default: qwen3\.6-35b-a3b/)
  assert.doesNotMatch(workflow, /qwen\/qwen3\.6-35b-a3b:(?:fp8|bf16)/)
  assert.match(workflow, /name: Verify fleet teardown\n\s+if: always\(\)/)
  assert.match(workflow, /task_names:/)
  assert.match(workflow, /profile:/)
  assert.match(workflow, /profiles:/)
  assert.match(workflow, /ttl_minutes:/)
  assert.match(workflow, /volume_size_gb:/)
  assert.match(workflow, /queue: max/)
  assert.match(workflow, /default: main-legacy/)
  assert.match(workflow, /default: '2048'/)
  assert.match(workflow, /default: '600'/)
  assert.match(workflow, /--task-names "\$TASK_NAMES"/)
  assert.match(workflow, /--profiles "\$PROFILES"/)
  assert.match(workflow, /--ttl-minutes "\$TTL_MINUTES"/)
  assert.match(workflow, /--volume-size-gb "\$VOLUME_SIZE_GB"/)
})

test('Scaleway workflow probes Object Storage with PutObject, not HeadBucket', () => {
  const workflow = readFileSync('.github/workflows/terminal-bench-scaleway.yml', 'utf8')
  assert.doesNotMatch(workflow, /head-bucket/)
  assert.match(workflow, /aws s3 cp - "s3:\/\/\$\{BUCKET\}\/\$\{probe_key\}"/)
  assert.match(workflow, /--sse AES256/)
  assert.match(workflow, /terminal-bench\/_github_preflight\//)
})

test('Scaleway workflow publishes a predictable post-run debugging manifest', () => {
  const workflow = readFileSync('.github/workflows/terminal-bench-scaleway.yml', 'utf8')
  assert.match(workflow, /name: Publish run manifest/)
  assert.match(workflow, /write-terminal-bench-run-manifest\.mts/)
  assert.match(
    workflow,
    /terminal-bench\/\$\{GITHUB_REPOSITORY\}\/\$\{GITHUB_RUN_ID\}\/\$\{GITHUB_RUN_ATTEMPT\}/,
  )
  assert.match(workflow, /\/run\.json"/)
})

test('worker image ships Docker CLI plugins Harbor needs for compose', () => {
  const dockerfile = readFileSync('benchmarks/terminal_bench/Dockerfile.worker', 'utf8')
  // Harbor drives each task with `docker compose --project-name …`. Copying only
  // the docker binary leaves compose unresolved and fails every shard as
  // infrastructure-invalid (`unknown flag: --project-name`).
  assert.match(
    dockerfile,
    /COPY --from=docker-cli \/usr\/local\/libexec\/docker\/cli-plugins \/usr\/local\/libexec\/docker\/cli-plugins/,
  )
})

test('fleet limits workers to the number of selected tasks', () => {
  const config = runConfig({ instances: '10', 'max-tasks': '3', 'worker-image': workerImage })
  assert.equal(config.instanceCount, 3)
  assert.equal(config.maxTasks, 3)
  assert.deepEqual(config.profiles, ['main-legacy'])
})

test('fleet validates and carries an explicit ablation profile', () => {
  assert.deepEqual(runConfig({ profile: 'pr-1149', 'worker-image': workerImage }).profiles, [
    'pr-1149',
  ])
  assert.throws(
    () => runConfig({ profile: 'unknown', 'worker-image': workerImage }),
    /profile must be/,
  )
})

test('fleet carries unique profiles for task-major rotation', () => {
  const config = runConfig({
    profiles: 'main-legacy,pr-1149,product-aligned',
    'no-steered-rerun': true,
    'worker-image': workerImage,
  })
  assert.deepEqual(config.profiles, ['main-legacy', 'pr-1149', 'product-aligned'])
  assert.deepEqual(rotateTerminalBenchProfiles(config.profiles, 0), [
    'main-legacy',
    'pr-1149',
    'product-aligned',
  ])
  assert.deepEqual(rotateTerminalBenchProfiles(config.profiles, 1), [
    'pr-1149',
    'product-aligned',
    'main-legacy',
  ])
  assert.deepEqual(rotateTerminalBenchProfiles(config.profiles, 2), [
    'product-aligned',
    'main-legacy',
    'pr-1149',
  ])
  assert.throws(
    () =>
      runConfig({
        profiles: 'main-legacy,main-legacy',
        'no-steered-rerun': true,
        'worker-image': workerImage,
      }),
    /must not contain duplicates/,
  )
  assert.throws(
    () => runConfig({ profiles: 'main-legacy,pr-1149', 'worker-image': workerImage }),
    /require --no-steered-rerun/,
  )
  assert.throws(
    () =>
      runConfig({
        profile: 'main-legacy',
        profiles: 'pr-1149',
        'worker-image': workerImage,
      }),
    /only one of --profile or --profiles/,
  )
})

test('worker runs task-major profiles with per-task checkpoints and pruning', () => {
  const script = readFileSync('benchmarks/terminal_bench/run-shard.sh', 'utf8')
  const checkpoint = readFileSync('benchmarks/terminal_bench/checkpoint-results.sh', 'utf8')
  const suite = readFileSync('scripts/run-terminal-bench-suite.mts', 'utf8')
  assert.match(script, /COPSE_TERMINAL_PROFILES/)
  assert.match(script, /--profiles="\$profiles_csv"/)
  assert.match(script, /--checkpoint-after-task/)
  assert.match(script, /--prune-images/)
  assert.doesNotMatch(script, /profile_offset/)
  assert.match(checkpoint, /bench:terminal:seal/)
  assert.match(checkpoint, /aws s3 cp/)
  assert.match(checkpoint, /--sse AES256/)
  assert.match(suite, /rotateTerminalBenchProfiles\(profiles, entry\.globalIndex\)/)
  assert.match(suite, /MAX_CONSECUTIVE_FULLY_INVALID_TASKS = 3/)
  assert.match(suite, /continuing the paired cohort/)
})

test('fleet accepts only exact registry task names and limits workers to that cohort', () => {
  const config = runConfig({
    instances: '10',
    'max-tasks': '10',
    'task-names': 'circuit-fibsqrt,break-filter-js-from-html',
    'worker-image': workerImage,
  })
  assert.equal(config.instanceCount, 2)
  assert.deepEqual(config.taskNames, ['circuit-fibsqrt', 'break-filter-js-from-html'])
  assert.throws(
    () =>
      runConfig({
        'task-names': 'not-a-terminal-bench-task',
        'worker-image': workerImage,
      }),
    /unknown Terminal-Bench task names/,
  )
})

test('fleet falls back across Scaleway regions when no zone is pinned', () => {
  const config = runConfig({ instances: '10', 'worker-image': workerImage })
  assert.deepEqual(config.zones, [
    'fr-par-1',
    'fr-par-2',
    'fr-par-3',
    'nl-ams-1',
    'nl-ams-2',
    'nl-ams-3',
    'pl-waw-1',
    'pl-waw-2',
    'pl-waw-3',
    'it-mil-1',
  ])
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

test('worker follow script reattaches to a still-running container after SSH drops', () => {
  const script = workerFollowRemoteScript('copse-terminal-shard-6')
  assert.match(script, /docker inspect -f '\{\{\.State\.Running\}\}' 'copse-terminal-shard-6'/)
  assert.match(script, /docker logs --follow 'copse-terminal-shard-6'/)
  assert.match(script, /docker wait 'copse-terminal-shard-6'/)
  assert.match(script, /exit "\$status"/)
})

test('worker image ships the Docker Compose CLI plugin for Harbor', () => {
  const dockerfile = readFileSync('benchmarks/terminal_bench/Dockerfile.worker', 'utf8')
  assert.match(dockerfile, /COPY --from=docker-cli \/usr\/local\/libexec\/docker\/cli-plugins/)
})
