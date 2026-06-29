import { readFileSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { runAgentLoop } from '../src/shared/agent/run-agent-loop.ts'
import { createLMStudioProvider } from '../src/shared/llm/create-provider.ts'
import type { LLMTool, StreamChunk } from '../src/shared/types'

const INCOMPLETE = 'stopped before producing a final answer'
const PROMPT =
  'Review this repository: what is it for and how is the codebase structured? Keep tool use reasonable.'
const RUN_TIMEOUT_MS = 15 * 60_000

const tools: LLMTool[] = [
  {
    name: 'list_dir',
    description: 'List files at a path relative to the repo root',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path' } },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file relative to the repo root',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required: ['path'],
    },
  },
]

function fail(msg: string): never {
  console.error(`validate:local-agent FAIL: ${msg}`)
  process.exit(1)
}

function loadSettings(): Record<string, unknown> {
  const settingsPath = join(homedir(), 'Library/Application Support/copse-panel/settings.json')
  return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
}

function loadLmStudioKey(): string {
  const fromEnv = process.env['LM_STUDIO_API_KEY']?.trim()
  if (fromEnv) return fromEnv
  fail('Set LM_STUDIO_API_KEY (LM Studio → Server → API keys) to run headless local validation.')
}

function settingString(settings: Record<string, unknown>, key: string, fallback = ''): string {
  const v = settings[key]
  return typeof v === 'string' ? v : fallback
}

function loadModel(settings: Record<string, unknown>): string {
  if (process.env['LM_STUDIO_MODEL']?.trim()) return process.env['LM_STUDIO_MODEL'].trim()
  const modelSetting = settingString(settings, 'model')
  if (modelSetting.startsWith('lmstudio:')) return modelSetting.slice('lmstudio:'.length)
  const configured = settingString(settings, 'localDefaultModel')
  if (configured) return configured
  fail('Set LM_STUDIO_MODEL or choose lmstudio:<id> in app settings.')
}

function resolvePath(workspace: string, path: string): string {
  const absRoot = resolve(workspace)
  const absTarget = path.startsWith('/') ? resolve(path) : resolve(absRoot, path || '.')
  const rel = relative(absRoot, absTarget)
  if (rel.startsWith('..') || rel.split(/[/\\]/).includes('..')) {
    throw new Error(`Path outside workspace: ${path}`)
  }
  return absTarget
}

async function executeTool(workspace: string, name: string, args: unknown): Promise<string> {
  const a = args as { path?: string }
  if (name === 'list_dir') {
    const dir = resolvePath(workspace, a.path ?? '.')
    const names = readdirSync(dir)
    return names
      .slice(0, 200)
      .map((n) => {
        const p = join(dir, n)
        return `${statSync(p).isDirectory() ? 'd' : 'f'} ${n}`
      })
      .join('\n')
  }
  if (name === 'read_file') {
    const file = resolvePath(workspace, a.path ?? '')
    const text = await readFile(file, 'utf8')
    return text.slice(0, 12_000)
  }
  throw new Error(`Unknown tool: ${name}`)
}

export async function validateLocalAgentFinalAnswer(): Promise<void> {
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['OPENAI_API_KEY']
  process.env['COPSE_PANEL_MOCK_LLM'] = ''

  const settings = loadSettings()
  const url =
    process.env['LM_STUDIO_URL']?.trim() ||
    settingString(settings, 'localServerUrl', 'http://localhost:1234/v1')
  const model = loadModel(settings)
  const apiKey = loadLmStudioKey()
  const workspace = process.cwd()

  const provider = createLMStudioProvider(url, model, apiKey)
  const messages = [
    {
      role: 'system' as const,
      content: `You are a coding assistant with tools. Working directory: ${workspace}. After exploring, answer the user in plain text.`,
    },
    { role: 'user' as const, content: PROMPT },
  ]

  const chunks: StreamChunk[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, RUN_TIMEOUT_MS)

  console.log(`validate:local-agent model=${model} workspace=${workspace}`)

  try {
    await runAgentLoop({
      provider,
      messages,
      tools,
      executeTool: (name, args, signal, _toolCallId) => {
        void signal
        return executeTool(workspace, name, args)
      },
      signal: controller.signal,
      maxSteps: 20,
      onChunk: (c) => {
        chunks.push(c)
        if (c.type === 'text' && c.text.trim()) process.stdout.write(c.text)
        if (c.type === 'tool_call') process.stdout.write(`\n[tool ${c.toolCall.name}]\n`)
      },
    })
  } finally {
    clearTimeout(timer)
  }

  const combined = chunks
    .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim()

  if (chunks.at(-1)?.type !== 'done') fail('Run ended without a done chunk.')
  if (!combined) fail('No assistant text was streamed.')
  if (combined.includes(INCOMPLETE)) fail('Incomplete-run stub instead of a real final answer.')
  if (combined.length < 80) fail(`Final answer too short (${String(combined.length)} chars).`)

  console.log('\nvalidate:local-agent PASS')
}

if (require.main === module) {
  validateLocalAgentFinalAnswer().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
