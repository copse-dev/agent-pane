import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { $, browser } from '@wdio/globals'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue, composerText } from './helpers/composer.ts'
import { waitForAgentIdle } from './helpers.ts'
import { E2E_SCREENSHOT_DIR, saveAppScreenshot } from './helpers/screenshot.ts'
import {
  startResponsivenessProbe,
  stopResponsivenessProbe,
  summarizeTimings,
} from './reasoning-responsiveness/probe.ts'

const producerSchema = z.object({
  sent: z.number().int(),
  count: z.literal(240),
  intervalMs: z.literal(20),
  chunk: z.string(),
  elapsedMs: z.number().positive(),
  startedAt: z.number().positive(),
  latenessMs: z.array(z.number().nonnegative()),
})

describe('reasoning responsiveness under a fixed ACP workload', () => {
  let workspace: string
  let fixtureRoot: string
  let producerPath: string
  let probing = false

  before(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'copse-reasoning-load-'))
    workspace = join(fixtureRoot, 'reasoning-workspace')
    mkdirSync(workspace)
    producerPath = join(fixtureRoot, 'producer.json')
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    seedEmptyProject(workspace, 'reasoning-load-project', {
      model: 'acp:reasoning-load-fixture',
      subagentsEnabled: false,
      registeredAcpAgents: [
        {
          id: 'reasoning-load-fixture',
          title: 'Reasoning fixture',
          enabled: true,
          command: process.execPath,
          args: [join(process.cwd(), 'tests/fixtures/reasoning-load-agent.mjs'), producerPath],
          modelsProbedAt: Date.now(),
        },
      ],
    })
    await browser.reloadSession()
  })

  after(async () => {
    if (probing) await stopResponsivenessProbe()
    resetUserData()
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  it('preserves every chunk and accepts trusted typing while recording frame gaps', async function () {
    this.timeout(90_000)
    await setComposerValue('Inspect the fixture and explain your reasoning.')
    await $('.submit-btn').click()
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          [...document.querySelectorAll('.message-reasoning-text')].some((node) =>
            node.textContent.includes('Live reasoning begins.'),
          ),
        ),
      { timeout: 30_000, timeoutMsg: 'ACP fixture did not begin its reasoning stream' },
    )
    await startResponsivenessProbe()
    probing = true
    await $('.prompt-input').click()
    const draft = 'Keep the earlier conclusions.'
    await browser.performActions([
      {
        type: 'key',
        id: 'reasoning-probe-typing',
        actions: [...draft].flatMap((value) => [
          { type: 'keyDown', value },
          { type: 'keyUp', value },
          { type: 'pause', duration: 200 },
        ]),
      },
    ])
    await browser.releaseActions()
    await waitForAgentIdle(30_000)
    const samples = await stopResponsivenessProbe()
    probing = false
    assert.equal(await composerText(), draft)
    const producer = safeJsonParse(
      readFileSync(producerPath, 'utf8'),
      decodeWithSchema(producerSchema),
    )
    assert.ok(producer)
    assert.equal(producer.sent, producer.count, 'producer must not drop work')
    assert.equal(producer.latenessMs.length, producer.count)
    assert.ok(samples.startedAt <= producer.startedAt, 'observer missed the start of the workload')
    assert.ok(
      samples.startedAt + samples.elapsedMs >= producer.startedAt + producer.elapsedMs,
      'observer stopped before the producer finished',
    )
    const content = await browser.execute(() =>
      [...document.querySelectorAll('.message-reasoning-text')].map((node) => node.textContent),
    )
    const live = content.find((text) => text.includes('Live reasoning begins.'))
    assert.ok(live)
    assert.equal(
      live.split('Checking the next detail').length - 1,
      producer.count * 8,
      'renderer must retain every reasoning chunk',
    )
    assert.equal(content.filter((text) => text.startsWith('Completed step')).length, 12)
    assert.equal(samples.hidden, false, 'hidden windows are invalid performance samples')
    assert.equal(samples.overflow, false, 'truncated measurements are invalid')
    assert.ok(samples.frameGapsMs.length >= 30, 'frame sampler did not run')
    assert.ok(samples.inputDelayMs.length >= draft.length, 'trusted typing was not observed')
    assert.ok(samples.inputFrameCheckpointMs.length >= draft.length, 'input checkpoints were lost')
    assert.equal(
      await browser.execute(
        () => [...document.querySelectorAll('.msg-assistant .message-text')].at(-1)?.textContent,
      ),
      'Reasoning workload complete.',
    )

    const outputDir = join(process.cwd(), 'e2e-failure-artifacts', 'responsiveness')
    mkdirSync(outputDir, { recursive: true })
    const report = {
      version: 1,
      scenario: 'reasoning-load',
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
      sourceHashes: Object.fromEntries(
        [
          'src/renderer/views/conversation.ts',
          'tests/fixtures/reasoning-load-agent.mjs',
          'tests/e2e/reasoning-responsiveness.e2e.ts',
          'tests/e2e/reasoning-responsiveness/probe.ts',
        ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
      ),
      platform: process.platform,
      arch: process.arch,
      browser: await browser.execute(() => navigator.userAgent),
      headless: process.env.COPSE_E2E_HEADLESS !== '0',
      gpuDisabled: true,
      producer,
      samples,
      summary: {
        frameGapsMs: summarizeTimings(samples.frameGapsMs),
        inputDelayMs: summarizeTimings(samples.inputDelayMs),
        inputFrameCheckpointMs: summarizeTimings(samples.inputFrameCheckpointMs),
        producerLatenessMs: summarizeTimings(producer.latenessMs),
      },
    }
    writeFileSync(join(outputDir, 'reasoning-load.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Responsiveness report: ${JSON.stringify(report.summary)}`)
    // Timing is report-only until the base/head variance is calibrated. Content,
    // valid samples and working input are hard assertions from the first run.
    await browser.execute(() => {
      const all = [...document.querySelectorAll<HTMLDetailsElement>('.message-reasoning')]
      const last = all.find((node) => node.textContent.includes('Live reasoning begins.'))
      if (last) last.open = true
    })
    await saveAppScreenshot('reasoning-responsiveness.png')
  })
})
