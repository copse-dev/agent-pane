/**
 * `pnpm run thread:container -- --workspace <dir> --prompt "<task>" …`
 * (`scripts/run-thread-container.mts` bundles this entry and runs it.)
 *
 * Run one thread unattended inside a disposable local container (Docker daemon required)
 * (`docs/plans/thread-in-container.md`). Builds the worker image on first use,
 * carries the workspace in as a git snapshot, runs the product's headless agent
 * with an unattended run armed (no prompts: contained effects run, outward
 * effects queue for review), and fetches the result back as commits under
 * `refs/copse/runs/<id>` for review. Nothing is pushed anywhere by the run.
 *
 *   --workspace <dir>       git checkout to carry in (default: cwd)
 *   --prompt <text>         the task
 *   --prompt-file <path>   read the task from a UTF-8 file instead of --prompt
 *   --report <path>        write the host run record as JSON for automation
 *   --rebase-onto <sha>    include this exact commit as refs/copse/rebase-base
 *   --install-dependencies install dependencies inside the guest
 *   --model <id>            model id the provider serves (default: $COPSE_MODEL)
 *   --provider-url <url>    OpenAI-compatible base URL this host calls for the guest's
 *                           inference; the guest never dials it, so it needs no --allow
 *                           entry (default: $COPSE_PROVIDER_URL)
 *   --api-key-env <NAME>    host env var holding the provider key (stays on this host)
 *   --allow <host:port>     guest egress origin the broker forwards to (repeatable);
 *                           governs the guest only, never the host's provider calls
 *   --resolve <host=addr>   dial <addr> on the host for an allowed origin whose name only
 *                           the guest resolves (repeatable; e.g. a local model server).
 *                           model.copse.internal, if allowed, must map to 127.0.0.1, ::1
 *                           or localhost (use [::1]:port for an IPv6 port override); the
 *                           broker dials localhost on loopback itself, never through the resolver
 *   --ttl <minutes>         wall-clock budget (default 120)
 *   --tokens <n>            token ceiling (default 2,000,000)
 *   --max-steps <n>         cap on agent steps (default: product default)
 *   --image <ref>           worker image (default copse-worker:local)
 *   --base-image <ref>      base image for --build (default: node:24-trixie-slim, pinned by digest)
 *   --build-network <net>   docker build --network (some sandboxes need host)
 *   --worker-bundle <path>  bundled guest entry (the wrapper passes the one it built)
 *   --build                 rebuild the worker image first
 *   --list                  list containers this host started and exit
 *   --teardown <runtimeId>  remove a container by runtime id and exit
 *   --sweep                 remove every managed container and volume that is not running
 *   --forget-store          remove the shared pnpm store volume; the next install refills it
 */
import { readFile, writeFile } from 'node:fs/promises'
import {
  assertThreadContainerEngine,
  buildWorkerImage,
  listManagedRuntimes,
  forgetPnpmStoreVolume,
  sweepOrphanedRuntimes,
  runThreadInContainer,
  teardownRuntime,
  WORKER_IMAGE,
} from './thread-container.ts'
import { createResolvedProviderFetch } from './resolved-provider-fetch.ts'
import { buildGuestProvider } from './guest-provider.ts'
import { withCredentialOutputRedaction } from '@copse/llm/credential-output-provider.ts'
import { HOST_INFERENCE_TARGET } from './host-inference-wire.ts'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import { takeProviderKeyFromEnv } from './cli-provider-key.ts'

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
    const boolean = ['build', 'list', 'sweep', 'forget-store', 'install-dependencies'].includes(
      name,
    )
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
  // Before any Docker command: the key must not sit in the environment every
  // Docker subprocess inherits.
  const apiKeyEnv = cli.one('api-key-env')
  const apiKey = takeProviderKeyFromEnv(apiKeyEnv)
  // One engine for the whole invocation; COPSE_CONTAINER_ENGINE picks it.
  const engine = await assertThreadContainerEngine()
  if (cli.has('list')) {
    for (const runtime of await listManagedRuntimes(engine)) {
      console.log(`${runtime.runtimeId}\t${runtime.status}`)
    }
    return
  }
  if (cli.has('forget-store')) {
    if (engine === 'apple') {
      console.log('pnpm store: none (runs under Apple container do not share one)')
      return
    }
    console.log(`pnpm store: ${await forgetPnpmStoreVolume()}`)
    return
  }
  if (cli.has('sweep')) {
    const sweep = await sweepOrphanedRuntimes([engine])
    console.log(
      `removed ${String(sweep.removed.length)}, skipped ${String(sweep.skipped.length)} running, failed ${String(sweep.failed.length)}`,
    )
    for (const id of sweep.failed) console.log(`could not remove ${id}`)
    return
  }
  const teardown = cli.one('teardown')
  if (teardown !== undefined) {
    console.log(`${teardown}: ${await teardownRuntime(teardown, engine)}`)
    return
  }

  const image = cli.one('image') ?? WORKER_IMAGE
  if (cli.has('build')) {
    const baseImage = cli.one('base-image') ?? process.env['COPSE_WORKER_BASE_IMAGE']
    const buildNetwork = cli.one('build-network') ?? process.env['COPSE_WORKER_BUILD_NETWORK']
    const workerBundle = cli.one('worker-bundle')
    await buildWorkerImage({
      engine,
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
  if (apiKeyEnv && !apiKey) throw new Error(`Provider key variable ${apiKeyEnv} is not set`)
  const maxSteps = cli.one('max-steps')
  const rebaseOnto = cli.one('rebase-onto')
  const model = required(cli.one('model') ?? process.env['COPSE_MODEL'], '--model')
  const transport = createResolvedProviderFetch(egressResolve)
  const record = await runThreadInContainer({
    engine,
    workspace: cli.one('workspace') ?? process.cwd(),
    prompt: cli.one('prompt-file')
      ? await readFile(required(cli.one('prompt-file'), '--prompt-file'), 'utf8')
      : required(cli.one('prompt'), '--prompt'),
    installDependencies: cli.has('install-dependencies'),
    ...(rebaseOnto ? { rebaseOnto } : {}),
    model,
    // CLI provider inference and its selected key stay on this host (A1″).
    hostInference: (maxOutputTokens): Promise<LLMProvider> =>
      Promise.resolve(
        withCredentialOutputRedaction(
          buildGuestProvider(
            {
              kind: 'openai-compatible',
              model,
              apiKeySlug: 'cli',
              url: providerUrl,
              label: 'the --provider-url endpoint',
              local: true,
              includeUsage: true,
              apiStyle: null,
              extraBody: null,
              params: { maxOutputTokens },
            },
            apiKey ?? null,
            transport.fetch,
          ),
          apiKey ? [apiKey] : [],
        ),
      ),
    budgets: {
      wallClockMs: Number(cli.one('ttl') ?? '120') * 60_000,
      tokenCeiling: Number(cli.one('tokens') ?? '2000000'),
    },
    egressAllowlist: [...new Set([HOST_INFERENCE_TARGET, ...allow])],
    egressResolve,
    image,
    ...(maxSteps !== undefined ? { maxSteps: Number(maxSteps) } : {}),
  }).finally(() => transport.close())
  const reportPath = cli.one('report')
  if (reportPath) await writeFile(reportPath, JSON.stringify(record), { mode: 0o600 })
  const result = record.result
  console.log('')
  console.log(`run ${record.runtimeId}: ${result?.stopReason ?? 'no result written'}`)
  console.log(
    `  harness: ${result === null ? 'unknown' : result.harness === 'copse' ? 'copse' : `ACP agent ${result.harness.acp}`}`,
  )
  console.log(`  prompts reached a handler: ${String(result?.promptsAttempted ?? 'unknown')}`)
  console.log(`  deferred for review: ${String(result?.deferrals.length ?? 'unknown')}`)
  console.log(`  refused by policy: ${String(result?.denials.length ?? 'unknown')}`)
  console.log(
    `  commits: ${String(result?.commits.length ?? 0)} → ${record.carryOut.ref ?? '(not fetched)'}`,
  )
  console.log(
    `  egress connections: ${String(record.egress.filter((e) => e.event === 'connect').length)}`,
  )
  console.log(`  secret canary: ${record.secretCanary.detail}`)
  console.log(`  teardown: ${record.teardown}`)
  if (record.carryOut.error !== null) console.log(`  carry-out FAILED: ${record.carryOut.error}`)
  if (record.cleanupError !== null) console.log(`  cleanup: ${record.cleanupError}`)
  if (result?.stopReason === 'error') process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
