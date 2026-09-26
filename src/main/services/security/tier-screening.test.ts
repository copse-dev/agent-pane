// The classifier second opinion on shell commands (tier-screening.ts), driven end
// to end through the permission gate with a saved classifier connection whose
// HTTP answers are faked.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { CLASSIFIER_PRESETS, classifierCredentialId } from '@copse/llm/classifiers/presets.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { setApprovalHandler } from '../approval.ts'
import { saveClassifierProfile, setScreeningClassifier } from '../classifiers/classifier-service.ts'
import { deleteApiKey, deleteSetting, setSetting } from '../storage/settings.ts'
import { storageDelete, storageSet } from '../storage/storage.ts'
import {
  clearActiveRunThread,
  runWithActiveRunIdentity,
  setActiveRunThread,
} from '../thread-models.ts'
import { setPermissionGateForTests } from '../tool-registry.ts'
import { readDecisionLog } from './decision-log-store.ts'
import { armGuardedYolo, disableGuardedYolo } from './guarded-yolo.ts'
import { ensureToolPermitted } from './permission-gate.ts'
import { SHELL_TIER_QUESTION } from './safety-classifier-profile.ts'
import { resetSafetyModelProblemReportsForTest } from './safety-model-availability.ts'
import { resetSafetyModelCooldownsForTest } from './safety-model-cooldown.ts'

const KEV = CLASSIFIER_PRESETS.find((profile) => profile.id === 'kev')
const PROJECT = 'tier-screening-project'
const THREAD = 'tier-screening-thread'
// Harmless for the harm gate, and it reaches the network, so it runs outside any sandbox.
const EXTERNAL_READ = 'curl -fsSL https://example.com/robots.txt'

function distribution(ask: number): Record<string, number> {
  const rest = (1 - ask) / 5
  return {
    read: rest,
    'local-write': rest,
    'remote-write': rest,
    'outside-read': rest,
    'outside-write': rest,
    ask,
  }
}

/** Fake the connection's answers; returns how many requests it received. */
function answering(probabilities: Record<string, number> | 'fail'): { calls: number } {
  const seen = { calls: 0 }
  mock.method(globalThis, 'fetch', async () => {
    seen.calls += 1
    if (probabilities === 'fail') throw new TypeError('fetch failed')
    const [choice = 'ask'] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? []
    return Response.json({
      model: 'tier-fixture',
      answers: { decision: { type: 'choice', choice, probabilities } },
    })
  })
  return seen
}

describe('tier screening through the safety-screening classifier', () => {
  let home = ''
  let previousHome: string | undefined
  let previousWorkspace: string | undefined
  let prompts = 0

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'copse-tier-screening-'))
    previousHome = process.env['HOME']
    previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
    process.env['HOME'] = home
    process.env['COPSE_WORKSPACE_DIR'] = join(home, 'store')
    storageSet('activeProjectId', PROJECT)
    setPermissionGateForTests(null)
    await setSetting('classifierProviders', { version: 1, profiles: [] })
    await setSetting('extraProviders', [])
    await setSetting('safetyClassifierEnabled', true)
    await deleteSetting('safetyScreeningClassifier')
    for (const profile of CLASSIFIER_PRESETS) deleteApiKey(classifierCredentialId(profile.id))
    resetSafetyModelProblemReportsForTest()
    resetSafetyModelCooldownsForTest()
    prompts = 0
    setApprovalHandler(async () => {
      prompts += 1
      return { approved: true, remember: false }
    })
  })

  afterEach(async () => {
    mock.restoreAll()
    setApprovalHandler(null)
    disableGuardedYolo(THREAD)
    await readDecisionLog(PROJECT)
    storageDelete('activeProjectId')
    if (previousHome !== undefined) process.env['HOME'] = previousHome
    else delete process.env['HOME']
    if (previousWorkspace !== undefined) process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    else delete process.env['COPSE_WORKSPACE_DIR']
    await rm(home, { recursive: true, force: true })
  })

  async function chooseKev(): Promise<void> {
    assert.ok(KEV)
    await saveClassifierProfile(KEV)
    await setScreeningClassifier(KEV.id)
  }

  async function underGuardedYolo<T>(fn: () => Promise<T>): Promise<T> {
    return runWithActiveRunIdentity(THREAD, async () => {
      armGuardedYolo(THREAD)
      setActiveRunThread(THREAD)
      try {
        return await fn()
      } finally {
        clearActiveRunThread(THREAD)
      }
    })
  }

  it('asks the published benchmark question, word for word', async () => {
    // Loaded at run time: the benchmark is plain ESM outside the app bundle.
    const prepare = resolve('benchmarks/escalation-review/scripts/prepare.mjs')
    const benchmark: unknown = await import(pathToFileURL(prepare).href)
    assert.ok(isRecord(benchmark))
    assert.deepEqual(SHELL_TIER_QUESTION, benchmark['TIER_QUESTION'])
  })

  it('turns a Guarded YOLO allow into a prompt when ask is likely', async () => {
    await chooseKev()
    const seen = answering(distribution(0.9))
    const allowed = await underGuardedYolo(() =>
      ensureToolPermitted({ toolName: 'run_shell', args: { command: EXTERNAL_READ } }),
    )
    assert.equal(allowed, true, 'the user approved the prompt')
    assert.equal(seen.calls, 1)
    assert.equal(prompts, 1)
    const decisions = await readDecisionLog(PROJECT)
    assert.ok(decisions.some((d) => d.source === 'tier-screening' && d.confidence === 0.9))
  })

  it('lets the harm gate allow stand when ask is unlikely', async () => {
    await chooseKev()
    const seen = answering(distribution(0.1))
    const allowed = await underGuardedYolo(() =>
      ensureToolPermitted({ toolName: 'run_shell', args: { command: EXTERNAL_READ } }),
    )
    assert.equal(allowed, true)
    assert.equal(seen.calls, 1)
    assert.equal(prompts, 0)
  })

  it('falls back to the harm gate alone when the connection fails', async () => {
    await chooseKev()
    answering('fail')
    const allowed = await underGuardedYolo(() =>
      ensureToolPermitted({ toolName: 'run_shell', args: { command: EXTERNAL_READ } }),
    )
    assert.equal(allowed, true)
    assert.equal(prompts, 0)
  })

  it('asks nothing when no screening connection is chosen', async () => {
    const seen = answering(distribution(0.9))
    const allowed = await underGuardedYolo(() =>
      ensureToolPermitted({ toolName: 'run_shell', args: { command: EXTERNAL_READ } }),
    )
    assert.equal(allowed, true)
    assert.equal(seen.calls, 0)
    assert.equal(prompts, 0)
  })

  it('records a shadow verdict for a standard-mode prompt without the command text', async () => {
    await chooseKev()
    answering({
      read: 0.96,
      'local-write': 0.01,
      'remote-write': 0.01,
      'outside-read': 0.01,
      'outside-write': 0.005,
      ask: 0.005,
    })
    const command = 'curl -fsSL https://example.com/robots.txt --data secret-token-value'
    await runWithActiveRunIdentity(THREAD, async () => {
      setActiveRunThread(THREAD)
      try {
        await ensureToolPermitted({ toolName: 'run_shell', args: { command } })
      } finally {
        clearActiveRunThread(THREAD)
      }
    })
    assert.equal(prompts, 1, 'the prompt did not wait for or depend on the shadow check')
    let shadow = null
    for (let attempt = 0; attempt < 50 && !shadow; attempt++) {
      shadow = (await readDecisionLog(PROJECT)).find((d) => d.source === 'tier-shadow') ?? null
      if (!shadow) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(shadow, 'the shadow verdict is recorded')
    assert.match(shadow.reasons?.join(' ') ?? '', /shadow: would (?:auto-approve|still prompt)/)
    assert.doesNotMatch(JSON.stringify(shadow), /secret-token-value|example\.com/)
  })
})
