import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import {
  OpenAiAgentsApi,
  openAiAgentStateSchema,
  type OpenAiAgentState,
} from '../src/main/services/remote/openai-agents-api.ts'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { DEFAULT_OPENAI_AGENT_MODEL } from '../src/shared/openai-cloud-agent.ts'

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    state: { type: 'string', default: '.tmp/openai-agent-session.json' },
    prompt: { type: 'string' },
    resume: { type: 'boolean' },
    delete: { type: 'boolean' },
    model: { type: 'string', default: DEFAULT_OPENAI_AGENT_MODEL },
  },
})

if (values.help) {
  console.log(
    'OPENAI_API_KEY must be configured. API and container charges apply.\nUsage: pnpm run probe:openai-agents [--state PATH] [--prompt TEXT | --resume | --delete] [--model MODEL]\nDefault task writes and runs a tiny Python script, then downloads its artifact. Ctrl-C cancels remote work and confirms its outcome. Session state is retained for follow-ups; --delete removes the remote session after work stops.',
  )
} else {
  const key = process.env['OPENAI_API_KEY']
  if (!key) throw new Error('Set OPENAI_API_KEY before running the billable smoke test.')
  const client = new OpenAiAgentsApi(key)
  const statePath = resolve(values.state)
  const controller = new AbortController()
  process.once('SIGINT', () => {
    controller.abort()
  })
  const save = (state: OpenAiAgentState): void => {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(`${statePath}.tmp`, statePath)
  }
  const existing = existsSync(statePath)
  if ((values.resume || values.delete) && !existing)
    throw new Error('No saved session at the selected state path.')
  const state = existing
    ? safeJsonParse(readFileSync(statePath, 'utf8'), decodeWithSchema(openAiAgentStateSchema))
    : await client.create(values.model, controller.signal)
  if (!state) throw new Error('Invalid saved session state; it has not been overwritten.')
  save(state)
  console.log(`Session: ${state.sessionId}`)
  if (values.delete) {
    if (state.pending) throw new Error('Recover the pending turn with --resume before deleting.')
    await client.delete(state, controller.signal)
    renameSync(statePath, `${statePath}.deleted`)
    console.log('Remote session deleted. Local artifacts retained.')
  } else {
    if (values.resume && !state.pending) throw new Error('The saved session has no pending task.')
    const prompt = values.resume
      ? state.pending?.prompt
      : (values.prompt ??
        'Create /workspace/outputs/hello.py containing print(2 + 2), execute it, and report the observed output. Do no other work.')
    if (!prompt) throw new Error('Missing task.')
    const result = await client.run(state, prompt, {
      signal: controller.signal,
      save,
      onText: (text) => process.stdout.write(text),
      onProgress: (type) => {
        console.log(`[${type}]`)
      },
    })
    console.log(
      `Status: ${result.status}; input tokens: ${String(result.inputTokens)}; output tokens: ${String(result.outputTokens)}; cached input: ${String(result.cacheReadTokens)}. Tool/container charges are additional.`,
    )
    let totalBytes = 0
    for (const artifact of result.artifacts.slice(0, 20)) {
      totalBytes += artifact.size_bytes
      if (totalBytes > 50 * 1024 * 1024)
        throw new Error('Artifact batch exceeds the 50 MiB probe limit.')
      const content = await client.download(state, artifact, AbortSignal.timeout(30_000))
      const filename = createHash('sha256').update(artifact.id).digest('hex')
      const target = join(dirname(statePath), `${filename}.artifact`)
      writeFileSync(target, content, { mode: 0o600 })
      console.log(`Artifact: ${target}`)
    }
    if (result.status === 'failed') throw new Error(result.error ?? 'Remote turn failed.')
  }
}
