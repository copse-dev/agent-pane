import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { threadToJsonl } from '../../src/renderer/export-thread.ts'
import type { Thread } from '@shared/types'
import { getCopseUserDataDir } from './helpers.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'

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

async function waitForAgentIdle(timeoutMs: number): Promise<void> {
  await browser.waitUntil(async () => (await $('.submit-btn').getText()) === 'Send', {
    timeout: timeoutMs,
    interval: 500,
    timeoutMsg: 'Agent did not return to idle (submit button Send)',
  })
  await browser.waitUntil(
    async () => {
      const disabled = await $('.prompt-input').getProperty('disabled')
      return disabled !== true
    },
    { timeout: 30_000, interval: 200 },
  )
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

describe('agent eval drive', () => {
  before(async () => {
    mkdirSync(ARTIFACTS, { recursive: true })
    resetUserData()
    const useMock = process.env.COPSE_EVAL_USE_MOCK === '1'
    seedEmptyProject(process.cwd(), 'agent-eval-project', {
      subagentsEnabled: useMock ? false : true,
      ...(useMock ? { model: 'claude-sonnet-4-6' } : {}),
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
      const textarea = await $('.prompt-input')
      await textarea.setValue(prompt)
      await $('.submit-btn').click()
      await waitForAgentIdle(idleTimeout)
    }

    const thread = readActiveThread()
    if (scenario.id === 'working-brief-eval') {
      assert.equal(thread.workingBrief, scenario.prompts[0])
    }
    const body = threadToJsonl(thread)
    const outPath = join(ARTIFACTS, `${scenario.id}-${Date.now()}.jsonl`)
    writeFileSync(outPath, body, 'utf8')
    process.stdout.write(`\nCOPSE_EVAL_ARTIFACT=${outPath}\n`)
  })
})
