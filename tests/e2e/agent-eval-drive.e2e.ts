import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { threadToJsonl } from '../../src/renderer/export-thread.ts'
import type { Thread } from '@shared/types'
import { getCopseUserDataDir } from './helpers.ts'
import { DEFAULT_APP_CHAT_MODEL, LM_STUDIO_MODEL_IDS } from '../../src/shared/lm-studio-defaults.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'

const ARTIFACTS = join(process.cwd(), 'tests/e2e/artifacts')
const DEFAULT_SCENARIO = join(process.cwd(), 'tests/e2e/scenarios/agent-eval.example.json')

interface EvalScenario {
  id: string
  description?: string
  prompts: string[]
}

function loadScenario(): EvalScenario {
  const path = process.env.COPSE_EVAL_SCENARIO?.trim() || DEFAULT_SCENARIO
  return JSON.parse(readFileSync(path, 'utf8')) as EvalScenario
}

async function typePrompt(text: string): Promise<void> {
  await waitForPromptReady()
  await browser.execute((value) => {
    const el = document.querySelector('.prompt-input') as HTMLTextAreaElement | null
    if (!el) throw new Error('.prompt-input not found')
    el.focus()
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, text)
}

function readActiveThread(): Thread {
  const configPath = join(getCopseUserDataDir(), 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  const projectId = config.activeProjectId as string
  const threads = config[`threads:${projectId}`] as Thread[]
  if (!Array.isArray(threads) || threads.length === 0) {
    throw new Error('No threads in config after eval run')
  }
  const activeId = config.activeThreadId as string | undefined
  const thread = threads.find((t) => t.id === activeId) ?? threads[threads.length - 1]
  if (!thread) throw new Error('Could not resolve active thread')
  return thread
}

function assertExploreSubagentCompleted(thread: Thread): void {
  const exploreCalls = thread.messages
    .flatMap((m) => m.toolCalls)
    .filter((tc) => tc.name === 'explore')
  assert.ok(exploreCalls.length > 0, 'expected at least one explore tool call')
  const completed = exploreCalls.filter(
    (tc) => tc.status === 'done' && typeof tc.result === 'string' && tc.result.trim().length > 20,
  )
  assert.ok(completed.length > 0, 'expected explore to complete with a non-empty summary result')
}

describe('agent eval drive', () => {
  before(async () => {
    mkdirSync(ARTIFACTS, { recursive: true })
    resetUserData()
    const useMock = process.env.COPSE_EVAL_USE_MOCK === '1'
    const lmStudioUrl = process.env.COPSE_EVAL_LM_STUDIO_URL?.trim() || 'http://localhost:1234/v1'
    const subagentsEnabled =
      process.env.COPSE_EVAL_SUBAGENTS === '0'
        ? false
        : process.env.COPSE_EVAL_SUBAGENTS === '1'
          ? true
          : !useMock
    seedEmptyProject(process.cwd(), 'agent-eval-project', {
      subagentsEnabled,
      ...(useMock
        ? { model: 'claude-sonnet-4-6' }
        : {
            model: DEFAULT_APP_CHAT_MODEL,
            lmStudioUrl,
            lmStudioModel: LM_STUDIO_MODEL_IDS.chat,
            lmStudioSubagentModel: LM_STUDIO_MODEL_IDS.smallTasks,
            lmStudioForSubagents: true,
          }),
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('runs scenario prompts against the real agent and writes JSONL artifact', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    const scenario = loadScenario()
    const idleTimeout = Number(process.env.COPSE_EVAL_IDLE_MS ?? 15 * 60_000)

    for (const prompt of scenario.prompts) {
      await typePrompt(prompt)
      await $('.submit-btn').click()
      await waitForAgentIdle(idleTimeout)
    }

    const thread = readActiveThread()
    if (
      scenario.id === 'working-brief-eval' ||
      scenario.id === 'working-brief-eval-lmstudio' ||
      scenario.id === 'working-brief-subagent-eval'
    ) {
      assert.equal(thread.workingBrief, scenario.prompts[0])
    }
    if (scenario.id === 'working-brief-subagent-eval' || scenario.id === 'todo-steer-deep-dive') {
      assertExploreSubagentCompleted(thread)
    }
    const body = threadToJsonl(thread)
    const outPath = join(ARTIFACTS, `${scenario.id}-${Date.now()}.jsonl`)
    writeFileSync(outPath, body, 'utf8')
    process.stdout.write(`\nCOPSE_EVAL_ARTIFACT=${outPath}\n`)
  })
})
