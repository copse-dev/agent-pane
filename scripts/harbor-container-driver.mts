/**
 * Host driver for running Copse's unattended container worker inside a
 * Terminal-Bench / Harbor task container (benchmark-only;
 * `docs/plans/thread-in-container.md`, decision A20).
 *
 * The container already exists (Harbor made it) and has the worker bundle and a
 * Node binary in it. This process stays on the host and:
 *
 * - writes `run.json` into the container and starts the Harbor worker through
 *   the caller's exec argv (`docker exec -i <name>` or
 *   `docker compose -p <project> exec -T main`), so the worker's stdin/stdout
 *   are a real pipe to this process;
 * - serves the product's stdio egress link over that pipe with the product's
 *   own `EgressBroker` and `HostInference`, whose provider is LM Studio built
 *   by the product's own provider code with the product's per-model recipe;
 *   the container never holds a credential or a model endpoint;
 * - enforces the wall-clock and token budgets (`HostInference`), records every
 *   provider request and per-call timing, and collects `out/` from the
 *   container into the artifacts directory.
 *
 * Bundled to `dist-test/` by `scripts/build-harbor-container.mts`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { createLMStudioProvider } from '@copse/llm/create-provider.ts'
import { withCredentialOutputRedaction } from '@copse/llm/credential-output-provider.ts'
import type {
  LLMMessage,
  LLMProvider,
  LLMStreamOptions,
  LLMTool,
  ProviderStreamChunk,
} from '@copse/llm/wire-types.ts'
import { EgressBroker } from '../src/main/services/container-runtime/egress-broker.ts'
import { parseEgressRule } from '../src/main/services/container-runtime/egress-rules.ts'
import { HostInference } from '../src/main/services/container-runtime/host-inference.ts'
import { HOST_INFERENCE_TARGET } from '../src/main/services/container-runtime/host-inference-wire.ts'
import type { ThreadContainerRunSpec } from '../src/main/services/container-runtime/run-spec.ts'
import { decodeWorkerPhase } from '../src/main/services/container-runtime/worker-events.ts'
import { stageSandboxRuntime } from '../src/main/services/container-runtime/thread-container.ts'
import { recordTerminalBenchProviderRequests } from './lib/terminal-bench-provider-recorder.mts'
import { writeTerminalModelParametersRecord } from './lib/terminal-bench-model-parameters.mts'
import { STEP_TIMING_FILE, StepTimingRecorder } from './lib/terminal-bench-step-timing.mts'
import {
  DEFAULT_HARBOR_CONTEXT_WINDOW,
  buildAppliedTuning,
  readTuningFile,
  resolveHostTuning,
  workerTuningFileText,
} from './lib/harbor-tuning-host.mts'
import {
  HARBOR_TUNING_APPLIED_FILE,
  HARBOR_TUNING_FILE,
} from '../src/main/services/container-runtime/harbor-tuning.mts'

interface Options {
  /** argv that runs a command in the task container, stdin attached (no TTY). */
  exec: string[]
  model: string
  lmStudioUrl: string
  instructionFile: string
  artifactsDir: string
  workspace: string
  /** Where inside the container the run directory goes. */
  containerRunDir: string
  containerNode: string
  containerWorker: string
  wallClockMs: number
  tokenCeiling: number
  contextWindow: number
  maxSteps: number | null
  /** Benchmark tuning (`harbor-tuning.mts`): a validated JSON file, or none. */
  tuningFile: string | null
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined)
      throw new Error(`Bad argument: ${name ?? '(missing)'}`)
    flags.set(name.slice(2), value)
  }
  const need = (name: string): string => {
    const value = flags.get(name)
    if (value === undefined || value === '') throw new Error(`--${name} is required`)
    return value
  }
  const exec: unknown = JSON.parse(need('exec-json'))
  if (
    !Array.isArray(exec) ||
    exec.length === 0 ||
    !exec.every((part) => typeof part === 'string')
  ) {
    throw new Error('--exec-json must be a non-empty JSON array of strings')
  }
  const maxSteps = flags.get('max-steps')
  return {
    exec: exec.map(String),
    model: need('model'),
    lmStudioUrl: flags.get('lm-studio-url') ?? 'http://localhost:1234/v1',
    instructionFile: need('instruction-file'),
    artifactsDir: resolve(need('artifacts-dir')),
    workspace: flags.get('workspace') ?? '/app',
    containerRunDir: flags.get('container-run-dir') ?? '/tmp/copse-run',
    containerNode: need('container-node'),
    containerWorker: need('container-worker'),
    wallClockMs: Number(flags.get('wall-clock-ms') ?? String(30 * 60_000)),
    tokenCeiling: Number(flags.get('token-ceiling') ?? '50000000'),
    contextWindow: Number(flags.get('context-window') ?? String(DEFAULT_HARBOR_CONTEXT_WINDOW)),
    maxSteps: maxSteps === undefined ? null : Number(maxSteps),
    tuningFile: flags.get('tuning-file') ?? null,
  }
}

/** Run a short command in the container, optionally feeding stdin; resolves with its stdout. */
function execIn(
  options: Options,
  command: readonly string[],
  stdin?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveExec, reject) => {
    const [bin, ...prefix] = options.exec
    if (bin === undefined) throw new Error('empty exec argv')
    const child = spawn(bin, [...prefix, ...command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      resolveExec({ code, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin ?? '')
  })
}

/** Per-model-call timing in `step-timing.jsonl`'s schema, from what the host can see. */
function timed(provider: LLMProvider, artifactsDir: string): LLMProvider {
  const recorder = new StepTimingRecorder({
    sink: (record): void => {
      appendFileSync(join(artifactsDir, STEP_TIMING_FILE), `${JSON.stringify(record)}\n`)
    },
  })
  let step = 0
  return {
    async *stream(
      messages: LLMMessage[],
      tools: LLMTool[],
      signal?: AbortSignal,
      streamOptions?: LLMStreamOptions,
    ): AsyncIterable<ProviderStreamChunk> {
      step += 1
      recorder.stepStarted(step)
      try {
        for await (const chunk of provider.stream(messages, tools, signal, streamOptions)) {
          recorder.chunk(chunk)
          yield chunk
        }
      } catch (error) {
        recorder.streamCut(error instanceof Error ? error.message : String(error))
        throw error
      } finally {
        recorder.finish()
      }
    },
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  mkdirSync(options.artifactsDir, { recursive: true })
  const apiKey = process.env['LM_STUDIO_API_KEY'] ?? 'lm-studio'
  // The key stays in this process; the container never sees it.
  delete process.env['LM_STUDIO_API_KEY']

  // Benchmark tuning: strictly validated before anything starts, so a bad
  // configuration fails the trial instead of silently measuring another one.
  const tuning = options.tuningFile === null ? null : readTuningFile(options.tuningFile)
  const resolved = resolveHostTuning({
    tuning,
    model: options.model,
    specMaxSteps: options.maxSteps,
    contextWindowFlag: options.contextWindow,
  })
  if (tuning !== null) {
    writeFileSync(
      join(options.artifactsDir, HARBOR_TUNING_FILE),
      `${JSON.stringify(tuning, null, 2)}\n`,
    )
  }
  const record = resolved.record
  writeTerminalModelParametersRecord(options.artifactsDir, record)
  let modelCalls = 0
  const provider = recordTerminalBenchProviderRequests(
    timed(
      withCredentialOutputRedaction(
        createLMStudioProvider(options.lmStudioUrl, options.model, apiKey, record.params),
        apiKey === 'lm-studio' ? [] : [apiKey],
      ),
      options.artifactsDir,
    ),
    join(options.artifactsDir, 'provider-requests.jsonl'),
    { mode: record.mode, params: record.params },
  )
  const counted: LLMProvider = {
    stream(messages, tools, signal, streamOptions) {
      modelCalls += 1
      return provider.stream(messages, tools, signal, streamOptions)
    },
  }

  const abort = new AbortController()
  const inference = new HostInference({
    // The per-request ceiling the host hands a provider factory is not
    // applied: the recipe's own output ceiling is the product's behaviour.
    provider: (): Promise<LLMProvider> => Promise.resolve(counted),
    tokenCeiling: options.tokenCeiling,
    wallClockMs: options.wallClockMs,
    signal: abort.signal,
  })
  const broker = new EgressBroker({
    rules: [parseEgressRule(HOST_INFERENCE_TARGET)],
    inference: (stream): Promise<void> => inference.serve(stream),
  })

  const instruction = await readFile(options.instructionFile, 'utf8')
  const runId = `harbor-${Date.now().toString(36)}`
  const spec: ThreadContainerRunSpec = {
    runtimeId: runId,
    threadId: `${runId}-thread`,
    projectId: `${runId}-project`,
    prompt: instruction,
    model: options.model,
    provider: null,
    contextWindow: resolved.contextWindow,
    apiKeyOverLink: false,
    hostInference: true,
    acp: null,
    installDependencies: false,
    budgets: { wallClockMs: options.wallClockMs, tokenCeiling: options.tokenCeiling },
    workspace: options.workspace,
    // Unused by the in-place Harbor entry; the schema requires a value.
    carryInRef: 'unused',
    carryInBase: 'unused',
    originUrl: null,
    maxSteps: options.maxSteps,
  }
  const runDir = options.containerRunDir
  const prepared = await execIn(
    options,
    ['sh', '-c', `mkdir -p '${runDir}/out' '${runDir}/state' && cat > '${runDir}/run.json'`],
    `${JSON.stringify(spec, null, 2)}\n`,
  )
  if (prepared.code !== 0) {
    throw new Error(`could not prepare the run directory: ${prepared.stderr || prepared.stdout}`)
  }

  if (tuning !== null) {
    const written = await execIn(
      options,
      ['sh', '-c', `cat > '${runDir}/${HARBOR_TUNING_FILE}'`],
      workerTuningFileText(tuning),
    )
    if (written.code !== 0) {
      throw new Error(`could not write the tuning file: ${written.stderr || written.stdout}`)
    }
  }

  const [bin, ...prefix] = options.exec
  if (bin === undefined) throw new Error('empty exec argv')
  const startedAt = Date.now()
  const worker: ChildProcess = spawn(
    bin,
    [
      ...prefix,
      'env',
      `COPSE_DIR=${runDir}/state`,
      `COPSE_HARBOR_RUN_DIR=${runDir}`,
      'COPSE_HOST_LINK=stdio',
      options.containerNode,
      options.containerWorker,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const { stdin, stdout, stderr } = worker
  if (!stdin || !stdout || !stderr) throw new Error('worker pipes were not created')
  stdin.on('error', () => {})
  broker.attach(stdout, stdin)
  const log = createWriteStream(join(options.artifactsDir, 'worker.log'))
  const phases: { phase: string; atMs: number }[] = []
  createInterface({ input: stderr }).on('line', (line) => {
    const phase = decodeWorkerPhase(line)
    if (phase !== null) {
      phases.push({ phase, atMs: Date.now() - startedAt })
      return
    }
    log.write(`${line}\n`)
  })

  // The worker stops itself 20 s before its own wall-clock budget; this is the
  // backstop if it does not.
  const backstop = setTimeout(() => {
    abort.abort()
    broker.stop()
    worker.kill('SIGKILL')
  }, options.wallClockMs + 60_000)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      worker.on('error', () => {
        resolveExit({ code: null, signal: null })
      })
      worker.on('close', (code, signal) => {
        resolveExit({ code, signal })
      })
    },
  )
  clearTimeout(backstop)
  inference.stop()
  broker.stop()
  log.end()

  const collected: Record<string, boolean> = {}
  for (const file of ['result.json', 'messages.json', 'transcript.json']) {
    const read = await execIn(options, ['cat', `${runDir}/out/${file}`])
    collected[file] = read.code === 0
    if (read.code === 0) {
      mkdirSync(join(options.artifactsDir, 'out'), { recursive: true })
      writeFileSync(join(options.artifactsDir, 'out', file), read.stdout)
    }
  }
  // The configuration this trial actually ran, next to result.json: the host's
  // resolved sampling and context window, and what the worker reported applying.
  const workerApplied = await execIn(options, ['cat', `${runDir}/${HARBOR_TUNING_APPLIED_FILE}`])
  mkdirSync(join(options.artifactsDir, 'out'), { recursive: true })
  writeFileSync(
    join(options.artifactsDir, 'out', HARBOR_TUNING_APPLIED_FILE),
    `${JSON.stringify(
      buildAppliedTuning({
        tuning,
        resolved,
        specMaxSteps: options.maxSteps,
        workerAppliedText: workerApplied.code === 0 ? workerApplied.stdout : null,
      }),
      null,
      2,
    )}\n`,
  )
  const summary = {
    schemaVersion: 1,
    workerExit: exit,
    wallMs: Date.now() - startedAt,
    modelCalls,
    phases,
    collected,
    egress: broker.log(),
  }
  writeFileSync(
    join(options.artifactsDir, 'driver-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  )
  console.log(JSON.stringify({ wallMs: summary.wallMs, modelCalls, collected, exit }))
  if (!collected['result.json']) process.exitCode = 2
}

/**
 * `stage <dir>`: copy the one external package the worker bundle loads at start
 * (the sandbox runtime and its dependencies) into `<dir>/node_modules`, with the
 * product's own staging function, so the bundle can sit beside it in the container.
 */
function stage(dir: string): void {
  const staged = stageSandboxRuntime(resolve(dir), process.cwd())
  console.log(`staged ${String(staged.length)} packages into ${resolve(dir)}/node_modules`)
}

const [command, argument] = process.argv.slice(2)
if (command === 'stage' && argument !== undefined) {
  stage(argument)
} else
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error)
    process.exitCode = 1
  })
