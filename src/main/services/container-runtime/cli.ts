/**
 * `pnpm run thread:container -- --workspace <dir> --prompt "<task>" …`
 * (`scripts/run-thread-container.mts` bundles this entry and runs it.)
 *
 * Run one thread unattended inside a disposable local Docker container
 * (`docs/plans/thread-in-container.md`). Builds the worker image on first use,
 * carries the workspace in as a git snapshot, runs the product's headless agent
 * with an unattended run armed (no prompts: contained effects run, outward
 * effects queue for review), and fetches the result back as commits under
 * `refs/copse/runs/<id>` for review. Nothing is pushed anywhere by the run.
 *
 *   --workspace <dir>       git checkout to carry in (default: cwd)
 *   --prompt <text>         the task
 *   --model <id>            model id the provider serves (default: $COPSE_MODEL)
 *   --provider-url <url>    OpenAI-compatible base URL the guest calls; its host:port
 *                           must be allowlisted (default: $COPSE_PROVIDER_URL)
 *   --api-key-env <NAME>    host env var holding the provider key (value passed, name kept)
 *   --allow <host:port>     egress origin the broker forwards to (repeatable)
 *   --resolve <host=addr>   dial <addr> on the host for an allowed origin whose name only
 *                           the guest resolves (repeatable; e.g. a local model server)
 *   --ttl <minutes>         wall-clock budget (default 120)
 *   --tokens <n>            token ceiling (default 2,000,000)
 *   --max-steps <n>         cap on agent steps (default: product default)
 *   --image <ref>           worker image (default copse-worker:local)
 *   --base-image <ref>      base image for --build (default node:22-bookworm-slim)
 *   --build-network <net>   docker build --network (some sandboxes need host)
 *   --worker-bundle <path>  bundled guest entry (the wrapper passes the one it built)
 *   --build                 rebuild the worker image first
 *   --list                  list containers this host started and exit
 *   --teardown <runtimeId>  remove a container by runtime id and exit
 */
import {
  buildWorkerImage,
  dockerAvailable,
  listManagedRuntimes,
  runThreadInContainer,
  teardownRuntime,
  WORKER_IMAGE,
} from './thread-container.ts'

interface Cli {
  flags: Map<string, string[]>
  has(name: string): boolean
  one(name: string): string | undefined
}

function parseCli(argv: readonly string[]): Cli {
  const flags = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? ''
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const name = token.slice(2)
    const next = argv[index + 1]
    const boolean = ['build', 'list'].includes(name)
    const value = boolean || next === undefined || next.startsWith('--') ? '' : next
    if (value !== '') index++
    const list = flags.get(name) ?? []
    list.push(value)
    flags.set(name, list)
  }
  return {
    flags,
    has: (name) => flags.has(name),
    one: (name) => flags.get(name)?.at(-1),
  }
}

function required(value: string | undefined, what: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${what} is required`)
  return value
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  if (!(await dockerAvailable())) {
    throw new Error('Docker is not available (is the daemon running?)')
  }
  if (cli.has('list')) {
    for (const runtime of await listManagedRuntimes()) {
      console.log(`${runtime.runtimeId}\t${runtime.status}`)
    }
    return
  }
  const teardown = cli.one('teardown')
  if (teardown !== undefined) {
    console.log(`${teardown}: ${await teardownRuntime(teardown)}`)
    return
  }

  const image = cli.one('image') ?? WORKER_IMAGE
  if (cli.has('build')) {
    const baseImage = cli.one('base-image') ?? process.env['COPSE_WORKER_BASE_IMAGE']
    const buildNetwork = cli.one('build-network') ?? process.env['COPSE_WORKER_BUILD_NETWORK']
    const workerBundle = cli.one('worker-bundle')
    await buildWorkerImage({
      image,
      ...(baseImage ? { baseImage } : {}),
      ...(buildNetwork ? { buildNetwork } : {}),
      ...(workerBundle ? { workerBundle } : {}),
    })
    console.log(`[thread-container] built ${image}`)
  }

  const providerUrl = required(
    cli.one('provider-url') ?? process.env['COPSE_PROVIDER_URL'],
    '--provider-url',
  )
  const allow = cli.flags.get('allow') ?? []
  const egressResolve: Record<string, string> = {}
  for (const entry of cli.flags.get('resolve') ?? []) {
    const [host, addr] = entry.split('=')
    if (!host || !addr) throw new Error(`--resolve expects host=addr, got "${entry}"`)
    egressResolve[host] = addr
  }
  const apiKeyEnv = cli.one('api-key-env')
  const maxSteps = cli.one('max-steps')
  const record = await runThreadInContainer({
    workspace: cli.one('workspace') ?? process.cwd(),
    prompt: required(cli.one('prompt'), '--prompt'),
    model: required(cli.one('model') ?? process.env['COPSE_MODEL'], '--model'),
    providerUrl,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    budgets: {
      wallClockMs: Number(cli.one('ttl') ?? '120') * 60_000,
      tokenCeiling: Number(cli.one('tokens') ?? '2000000'),
    },
    egressAllowlist: allow,
    egressResolve,
    image,
    ...(maxSteps !== undefined ? { maxSteps: Number(maxSteps) } : {}),
  })
  const result = record.result
  console.log('')
  console.log(`run ${record.runtimeId}: ${result?.stopReason ?? 'no result written'}`)
  console.log(`  prompts reached a handler: ${String(result?.promptsAttempted ?? 'unknown')}`)
  console.log(`  deferred for review: ${String(result?.deferrals.length ?? 'unknown')}`)
  console.log(
    `  commits: ${String(result?.commits.length ?? 0)} → ${record.carryOutRef ?? '(none)'}`,
  )
  console.log(
    `  egress connections: ${String(record.egress.filter((e) => e.event === 'connect').length)}`,
  )
  console.log(`  secret canary: ${record.secretCanary.detail}`)
  console.log(`  teardown: ${record.teardown}`)
  if (result?.stopReason === 'error') process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
