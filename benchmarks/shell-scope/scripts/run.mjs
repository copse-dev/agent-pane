import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const scripts = dirname(fileURLToPath(import.meta.url))
export const repository = resolve(scripts, '../../..')
export const root = resolve(process.env.COPSE_BENCH_OUTPUT ?? 'bench-results/shell-scope')
export const assets = resolve(process.env.COPSE_BENCH_ASSETS ?? 'bench-results/shell-model-assets')
export const prior = repository
export const corpus = resolve(scripts, '../inputs')
export const { z } = createRequire(resolve(prior, 'package.json'))('zod')
export const sha = (value) => createHash('sha256').update(value).digest('hex')
export const decodeWithSchema = (schema) => (value) => schema.parse(value)
export const safeJsonParse = (text, decode) => decode(JSON.parse(text))
export const inputSchema = z
  .object({
    id: z.string(),
    state: z.record(z.string(), z.unknown()),
    question: z.string(),
    options: z
      .array(z.object({ id: z.enum(['sandbox', 'external']), description: z.string() }).strict())
      .length(2),
  })
  .strict()
export function payloadFor(input) {
  return {
    state: input.state,
    questions: {
      resolution: {
        type: 'choice',
        instructions: input.question,
        criteria: Object.fromEntries(
          input.options.map((option) => [option.id, option.description]),
        ),
      },
    },
  }
}
export function assertSanitized(input) {
  const command = z.string().parse(input.state.command)
  assert.ok(
    !/(?:sk-[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN .*PRIVATE KEY|(?:api_key|password|secret|token)\s*=\s*[^\s'"]{12,})/i.test(
      command,
    ),
    'Potential credential in command; no request sent',
  )
  assert.ok(
    !command.includes('/Users/') && !command.includes('PRIVATE_USER_SENTINEL'),
    'Unredacted personal path; no request sent',
  )
}
const configs = {
  laya: {
    kind: 'laya',
    model: 'convaiinnovations/laya',
    revision: 'c5d78730f3493e4fe16d61507ef4b78eef7318cf',
    subfolder: 'typed-decisions',
    environment: 'roadmap-env',
    device: 'cpu',
  },
  'laya-base': {
    kind: 'laya',
    model: 'convaiinnovations/laya',
    revision: 'c5d78730f3493e4fe16d61507ef4b78eef7318cf',
    environment: 'roadmap-env',
    device: 'cpu',
  },
  kev: {
    kind: 'kev',
    model: 'jaredpalmer/kev-0.5b',
    revision: 'edf1dc6d7f8d983c0adfd251e80a686e5539fc61',
    environment: 'roadmap-kev-env',
    device: 'cpu',
    source: 'kev-31161d3d092be662bb0bf288bc5cd643927d1d88',
  },
  openjev: {
    kind: 'semif',
    model: 'AlexWortega/openjev',
    revision: '4b5f9a67fa2ebe77466bce0656ce350effc3148c',
    subfolder: 'qwen3.5-4b-nli-v2',
    environment: 'semif-eval-2026-09-22/env',
    device: 'mps',
  },
  'nimble-demo': {
    kind: 'nimble-demo',
    model: 'bespokelabs/Bespoke-Nimble-9B',
    revision: 'hosted-unverified',
    environment: 'roadmap-env',
    device: 'cpu',
    hosted: true,
  },
}
export async function main() {
  const [candidate, split, version = 'v1', limitText] = process.argv.slice(2)
  assert.ok(
    Object.hasOwn(configs, candidate) || ['jev', 'acp'].includes(candidate),
    'Unknown candidate',
  )
  assert.ok(['dev', 'holdout'].includes(split))
  assert.match(version, /^[a-z0-9-]+$/)
  const text = await readFile(resolve(corpus, `${split}-inputs/dev.jsonl`), 'utf8')
  const expected = {
    dev: '42fd4096de4d1a699608812c431be2a9a78afa9e2cd2f882ba3db939e0bd278d',
    holdout: 'd9bdd6401edd809104a713d03231fffd32a59dafe1806a47f8ca77af61778e62',
  }
  assert.equal(sha(text), expected[split])
  let inputs = text
    .trim()
    .split('\n')
    .map((line) => safeJsonParse(line, decodeWithSchema(inputSchema)))
  assert.equal(inputs.length, 200)
  if (limitText) {
    assert.equal(split, 'dev', 'Only development probes can be limited')
    const limit = Number(limitText)
    assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= inputs.length)
    inputs = inputs.slice(0, limit)
  }
  for (const input of inputs) assertSanitized(input)
  if (['acp', 'jev', 'nimble-demo'].includes(candidate)) {
    assert.equal(
      process.env.COPSE_BENCH_HOSTED_ACK,
      `${candidate}:${split}:${sha(text)}`,
      'Hosted submission requires explicit payload/destination review; see README',
    )
  }
  await mkdir(root, { recursive: true })
  const directory = resolve(root, `${candidate}-${split}-${version}`)
  await mkdir(directory, { mode: 0o700 })
  const started = performance.now()
  const config = configs[candidate] ?? null
  const run = {
    candidate,
    split,
    version,
    startedAt: new Date().toISOString(),
    inputHash: sha(text),
    requested: config,
    transport:
      candidate === 'acp'
        ? 'ACP'
        : candidate === 'jev'
          ? 'HTTPS System One'
          : config.hosted
            ? 'Gradio hosted demo'
            : 'local Python JSONL',
    planned: inputs.map((row) => row.id),
    sanitizedScanPassed: true,
    workerHash: sha(await readFile(resolve(scripts, 'roadmap-model-worker.py'))),
    setup: null,
    warmup: null,
    attempted: 0,
    errors: 0,
    unattempted: inputs.length,
    runError: null,
    completed: false,
    costUsd: null,
    notes: [
      'No labels loaded; fixture commands never executed.',
      'Independent human review pending; private, not publication eligible.',
      'semif worker kind means historical OpenJev NLI, not actual SemIf.',
    ],
  }
  const persist = () =>
    writeFile(resolve(directory, 'run.json'), JSON.stringify(run, null, 2) + '\n', { mode: 0o600 })
  await persist()
  await writeFile(
    resolve(directory, 'inputs.jsonl'),
    inputs.map((row) => JSON.stringify({ id: row.id, payload: payloadFor(row) })).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 },
  )
  let worker
  try {
    let evaluate
    if (config) {
      const { LocalChoiceJudge } = await import(
        pathToFileURL(resolve(scripts, 'lib/roadmap-judge-local.mts')).href
      )
      const args = [
        candidate === 'openjev'
          ? resolve(scripts, 'openjev-worker.py')
          : resolve(scripts, 'roadmap-model-worker.py'),
        '--kind',
        config.kind,
        '--model',
        config.model,
        '--revision',
        config.revision,
        '--device',
        config.device,
        '--cache-dir',
        resolve(assets, 'roadmap-model-cache'),
        ...(config.subfolder ? ['--subfolder', config.subfolder] : []),
        ...(config.source ? ['--source-dir', resolve(assets, config.source)] : []),
      ]
      if (candidate === 'openjev') {
        process.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO = '0.9'
        process.env.PYTORCH_MPS_LOW_WATERMARK_RATIO = '0.8'
        run.openjevWorkerHash = sha(await readFile(resolve(scripts, 'openjev-worker.py')))
        run.memoryGuard = 'MPS high watermark 0.9, low watermark 0.8; no CPU fallback enabled'
      }
      run.command = { executable: resolve(assets, config.environment, 'bin/python'), args }
      if (!config.hosted) {
        process.env.HF_HUB_OFFLINE = '1'
        process.env.TRANSFORMERS_OFFLINE = '1'
      }
      process.env.HF_HUB_DISABLE_TELEMETRY = '1'
      process.env.TOKENIZERS_PARALLELISM = 'false'
      worker = new LocalChoiceJudge(run.command.executable, args, 180000)
      run.setup = await worker.ready()
      if (!config.hosted) assert.ok(run.setup.model.includes(`@${config.revision}`))
      evaluate = (input) => worker.evaluatePayload(payloadFor(input), ['sandbox', 'external'])
      if (!config.hosted) {
        run.warmup = await evaluate(inputs[0])
        if (run.warmup.fatal) throw new Error(run.warmup.error ?? 'Fatal warmup failure')
      }
    } else if (candidate === 'jev') {
      if (!process.env.TYPESAFE_API_KEY)
        throw new Error('TYPESAFE_API_KEY is not configured; no request sent')
      const { evaluateChoiceHttp } = await import(
        pathToFileURL(resolve(scripts, 'lib/choice-judge-provider.mts')).href
      )
      evaluate = (input) =>
        evaluateChoiceHttp(payloadFor(input), '', {
          protocol: 'systemone',
          endpoint: 'https://api.typesafe.ai/v1/systemone',
          model: 'jev-1.13.0',
          apiKey: process.env.TYPESAFE_API_KEY,
          timeoutMs: 60000,
        })
    } else {
      const { evaluateAcpText } = await import(
        pathToFileURL(resolve(scripts, 'lib/acp-text-judge.mts')).href
      )
      const { choicePrompt, decodeChoice } = await import(
        pathToFileURL(resolve(scripts, 'lib/choice-judge.mts')).href
      )
      const { createTextOnlyTransport } = await import('./acp-transport.mjs')
      run.toolControls = {
        tools: [],
        mcpServers: [],
        settingSources: [],
        strictMcpConfig: true,
        allowDangerouslySkipPermissions: false,
        maxTurns: 1,
        permissionRequests: 'deny-all',
      }
      evaluate = async (input) => {
        const result = await evaluateAcpText(
          choicePrompt(payloadFor(input)),
          {
            command: process.env.COPSE_BENCH_ACP_COMMAND ?? 'claude-agent-acp',
            args: [],
            model: 'opus[1m]',
            timeoutMs: 90000,
          },
          createTextOnlyTransport,
        )
        const verdict = result.error ? null : decodeChoice(result.text, ['sandbox', 'external'])
        return {
          verdict,
          probabilities: null,
          model: result.model,
          usage: result.usage,
          latencyMs: result.latencyMs,
          error: result.error ?? (verdict ? null : 'Invalid categorical output'),
          fatal: Boolean(result.error),
          text: result.text,
          acp: result.acp ?? null,
        }
      }
    }
    await persist()
    for (const input of inputs) {
      const native = await evaluate(input)
      const probabilities = native.probabilities
        ? ['sandbox', 'external'].map((label) => native.probabilities[label])
        : null
      if (!native.error && probabilities) {
        assert.ok(
          probabilities.every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
        )
        assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) <= 0.010001)
        assert.equal(
          native.verdict,
          ['sandbox', 'external'][probabilities.indexOf(Math.max(...probabilities))],
        )
      }
      const row = { id: input.id, payloadHash: sha(JSON.stringify(payloadFor(input))), native }
      await appendFile(resolve(directory, 'rows.jsonl'), JSON.stringify(row) + '\n', {
        mode: 0o600,
      })
      run.attempted++
      run.errors += Number(Boolean(native.error))
      run.unattempted--
      console.log(
        `${candidate} ${run.attempted}/${inputs.length} ${input.id}: ${native.error ?? native.verdict}`,
      )
      if (run.attempted % 20 === 0 || native.fatal) await persist()
      if (native.fatal) {
        run.runError = native.error
        break
      }
    }
    run.completed = run.unattempted === 0 && run.errors === 0
  } catch (error) {
    run.runError =
      worker?.setupError ?? (error instanceof Error ? error.message : 'Unknown run failure')
  } finally {
    worker?.close()
    run.finishedAt = new Date().toISOString()
    run.elapsedSeconds = (performance.now() - started) / 1000
    await persist()
  }
  console.log(
    JSON.stringify({
      directory,
      attempted: run.attempted,
      errors: run.errors,
      unattempted: run.unattempted,
      runError: run.runError,
      elapsedSeconds: run.elapsedSeconds,
    }),
  )
  if (!run.completed) process.exitCode = 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
