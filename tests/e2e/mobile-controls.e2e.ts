import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { $, browser, expect } from '@wdio/globals'
import { decodeWithSchema, safeJsonParse } from '../../packages/std/src/safe-json.ts'
import { parseDecisionLog } from '../../src/shared/threads/decision-log.ts'
import { copseDataRoot } from '../../src/main/services/storage/copse-paths.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { installMockScenario, expectAssistantReply } from './helpers/mock-scenario.ts'
import { waitForAgentIdle } from './helpers.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'

const projectId = 'e2e-mobile-control'
const token = randomBytes(32).toString('hex')
const readToken = randomBytes(32).toString('hex')
const addresses = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter(
    (entry) =>
      entry.family === 'IPv4' &&
      !entry.internal &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
  )
  .map((entry) => entry.address)
let origin = ''

async function availableAddress(): Promise<string | undefined> {
  // A daily Copse may already own the stable port on one interface. Probe only
  // availability; never stop it or send test actions to an unrelated profile.
  for (const address of addresses) {
    const available = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => {
        resolve(false)
      })
      probe.listen(42773, address, () => {
        probe.close(() => {
          resolve(true)
        })
      })
    })
    if (available) return address
  }
  return undefined
}

const root = join(copseDataRoot(), 'lan')
const responseSchema = z.object({
  id: z.uuid().optional(),
  code: z.string().optional(),
  state: z.string().optional(),
  token: z.string().optional(),
  access: z.enum(['read', 'control']).optional(),
  sessionId: z.string().optional(),
  threadId: z.string().optional(),
  ok: z.boolean().optional(),
  queued: z.boolean().optional(),
  error: z.string().optional(),
  runId: z.string().nullable().optional(),
  decisions: z.array(z.object({ id: z.string(), kind: z.string() })).optional(),
})

function request(path: string, body?: object, bearer = token): z.infer<typeof responseSchema> {
  const args = [
    '--silent',
    '--show-error',
    '--noproxy',
    '*',
    '--max-time',
    '70',
    '--cacert',
    join(root, 'ca.crt'),
    '-H',
    `Authorization: Bearer ${bearer}`,
    '-H',
    `Origin: ${origin}`,
  ]
  if (body) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-')
  const output = execFileSync('/usr/bin/curl', [...args, `${origin}${path}`], {
    encoding: 'utf8',
    ...(body ? { input: JSON.stringify(body) } : {}),
  })
  const parsed = safeJsonParse(output, decodeWithSchema(responseSchema))
  assert.ok(parsed, 'API returned valid JSON')
  return parsed
}

function action(sessionId: string, payload: object): Record<string, unknown> {
  return { sessionId, issuedAt: Date.now(), requestId: randomUUID(), projectId, ...payload }
}

describe('Mobile Companion control over verified local HTTPS', function () {
  this.timeout(180_000)
  before(async () => {
    const address = await availableAddress()
    assert.ok(
      address,
      'The LAN runtime eval requires an unused private IPv4 interface on port 42773',
    )
    origin = `https://${address}:42773`
    resetUserData()
    seedEmptyProject(process.cwd(), projectId, {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      autoRunSandboxCommands: false,
    })
    // Fixture at the persisted-device boundary: no test-only product authority flag.
    mkdirSync(root, { recursive: true, mode: 0o700 })
    writeFileSync(join(root, 'service.json'), JSON.stringify({ enabled: true, address }), {
      mode: 0o600,
    })
    writeFileSync(
      join(root, 'devices.json'),
      JSON.stringify([
        {
          id: randomUUID(),
          label: 'Runtime test phone',
          tokenHash: createHash('sha256').update(token).digest('hex'),
          createdAt: Date.now(),
          access: 'control',
        },
        {
          id: randomUUID(),
          label: 'Read only test phone',
          tokenHash: createHash('sha256').update(readToken).digest('hex'),
          createdAt: Date.now(),
          access: 'read',
        },
      ]),
      { mode: 0o600 },
    )
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
  })

  it('starts once, queues a follow-up, answers the desktop prompt, and rejects stale actions', async () => {
    const first = 'Start this chat from my phone and ask which tests to run.'
    const followup = 'Report the final result to my phone.'
    const scenario = await installMockScenario(
      {
        title: 'Phone runtime control',
        turns: [
          {
            user: first,
            responses: [
              {
                toolCalls: [
                  {
                    name: 'ask_user',
                    args: {
                      questions: [
                        { question: 'Which tests should I run?', options: ['Focused tests'] },
                      ],
                    },
                  },
                ],
              },
              {
                text: 'The focused tests passed.',
                expectToolResults: [{ name: 'ask_user', includes: 'Focused tests' }],
              },
            ],
          },
          {
            user: followup,
            responses: [{ text: 'Your phone started this chat and queued this follow-up.' }],
          },
        ],
      },
      null,
    )
    let sessionId = ''
    await browser.waitUntil(
      () => {
        try {
          sessionId = request('/api/activity').sessionId ?? ''
          return Boolean(sessionId)
        } catch {
          return false
        }
      },
      { timeout: 30_000, interval: 500 },
    )
    const start = action(sessionId, { action: 'message', threadId: null, text: first })
    assert.match(request('/api/action', start, readToken).error ?? '', /Enable control/)
    const started = request('/api/action', start)
    assert.equal(started.ok, true, started.error ?? 'Mobile message start failed')
    assert.ok(started.threadId)
    const threadId = started.threadId
    assert.deepEqual(
      request('/api/action', start),
      started,
      'duplicate delivery returns the same chat',
    )
    await $('#ask-user-dialog').waitForDisplayed({ timeout: 30_000 })
    const waiting = request(`/api/thread/${projectId}/${threadId}`)
    const question = waiting.decisions?.find((decision) => decision.kind === 'question')
    assert.ok(question)
    assert.ok(waiting.runId)
    const queued = request(
      '/api/action',
      action(sessionId, { action: 'message', threadId, text: followup }),
    )
    assert.equal(queued.queued, true, queued.error ?? 'Mobile message queue failed')
    await expect($('.footer-queue')).toHaveText('1 queued')
    await saveAppScreenshot('mobile-controls-queued-desktop.png')
    assert.equal(
      request(
        '/api/action',
        action(sessionId, {
          action: 'answer',
          threadId,
          decisionId: question.id,
          answers: ['Focused tests'],
        }),
      ).ok,
      true,
    )
    await $('#ask-user-dialog').waitForDisplayed({ reverse: true, timeout: 10_000 })
    assert.match(
      request(
        '/api/action',
        action(sessionId, {
          action: 'answer',
          threadId,
          decisionId: question.id,
          answers: ['Other'],
        }),
      ).error ?? '',
      /already changed/,
    )
    await waitForAgentIdle(60_000)
    await expectAssistantReply('Your phone started this chat and queued this follow-up.')
    await scenario.assertComplete()
    assert.match(
      request('/api/action', action(sessionId, { action: 'stop', threadId, runId: waiting.runId }))
        .error ?? '',
      /already changed/,
    )
    await saveAppScreenshot('mobile-controls-finished-desktop.png')

    const approvalPrompt = 'Check whether reading the Copse profile is allowed.'
    const approvalScenario = await installMockScenario({
      title: 'Phone approval',
      turns: [
        {
          user: approvalPrompt,
          responses: [
            { toolCalls: [{ name: 'run_shell', args: { command: 'ls -la ~/.copse' } }] },
            {
              text: 'The phone declined the profile read.',
              expectToolResults: [{ name: 'run_shell' }],
            },
          ],
        },
      ],
    })
    assert.equal(
      request(
        '/api/action',
        action(sessionId, { action: 'message', threadId, text: approvalPrompt }),
      ).ok,
      true,
    )
    await $('#approval-dialog').waitForDisplayed({ timeout: 30_000 })
    const approval = request(`/api/thread/${projectId}/${threadId}`).decisions?.find(
      (decision) => decision.kind === 'approval',
    )
    assert.ok(approval)
    assert.match(
      request(
        '/api/action',
        action(sessionId, {
          action: 'approval',
          threadId,
          decisionId: approval.id,
          approved: true,
          remember: true,
        }),
      ).error ?? '',
      /Invalid action/,
    )
    assert.equal(
      request(
        '/api/action',
        action(sessionId, {
          action: 'approval',
          threadId,
          decisionId: approval.id,
          approved: false,
        }),
      ).ok,
      true,
    )
    await $('#approval-dialog').waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The phone declined the profile read.')
    await approvalScenario.assertComplete()

    const allowPrompt = 'Run the harmless command I approve from my phone.'
    const allowScenario = await installMockScenario({
      title: 'Approve once from phone',
      turns: [
        {
          user: allowPrompt,
          responses: [
            { toolCalls: [{ name: 'run_shell', args: { command: "printf 'phone-approved'" } }] },
            {
              text: 'The approved command completed.',
              expectToolResults: [{ name: 'run_shell', includes: 'phone-approved' }],
            },
          ],
        },
      ],
    })
    assert.equal(
      request('/api/action', action(sessionId, { action: 'message', threadId, text: allowPrompt }))
        .ok,
      true,
    )
    await $('#approval-dialog').waitForDisplayed({ timeout: 30_000 })
    const once = request(`/api/thread/${projectId}/${threadId}`).decisions?.find(
      (decision) => decision.kind === 'approval',
    )
    assert.ok(once)
    assert.equal(
      request(
        '/api/action',
        action(sessionId, { action: 'approval', threadId, decisionId: once.id, approved: true }),
      ).ok,
      true,
    )
    await $('#approval-dialog').waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The approved command completed.')
    await allowScenario.assertComplete()
    const decisions = parseDecisionLog(
      readFileSync(join(copseDataRoot(), 'workspace', projectId, threadId, 'events.jsonl'), 'utf8'),
    )
    const phoneApprovals = decisions.filter(
      (decision) => decision.actor === 'mobile-device' && decision.kind === 'shell',
    )
    assert.deepEqual(
      phoneApprovals.map((decision) => decision.verdict),
      ['denied', 'approved'],
    )
    assert.ok(
      phoneApprovals.every(
        (decision) =>
          decision.remembered === false && decision.source?.includes('Runtime test phone'),
      ),
    )

    const stopScenario = await installMockScenario({
      title: 'Stop from phone',
      turns: [
        {
          user: 'Wait for my phone to stop this run.',
          allowAbort: true,
          responses: [{ waitFor: 'phone-stop', text: 'This must be interrupted.' }],
        },
      ],
    })
    assert.equal(
      request(
        '/api/action',
        action(sessionId, {
          action: 'message',
          threadId,
          text: 'Wait for my phone to stop this run.',
        }),
      ).ok,
      true,
    )
    await stopScenario.waitForHold('phone-stop')
    const running = request(`/api/thread/${projectId}/${threadId}`)
    assert.ok(running.runId)
    assert.notEqual(running.runId, waiting.runId)
    assert.match(
      request('/api/action', action(sessionId, { action: 'stop', threadId, runId: waiting.runId }))
        .error ?? '',
      /already changed/,
    )
    assert.equal(
      request('/api/action', action(sessionId, { action: 'stop', threadId, runId: running.runId }))
        .ok,
      true,
    )
    await waitForAgentIdle(30_000)
    await stopScenario.assertComplete()
    await saveAppScreenshot('mobile-controls-stopped-desktop.png')
  })

  it('pairs through shared auth, retains phone credentials on restart, revokes them and cancels pending consent on stop', async () => {
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="experimental"]').click()
    let enabled = $('input[name="mobileCompanionEnabled"]')
    await enabled.scrollIntoView({ block: 'center' })
    const pairing = request('/api/pair/request', { label: 'Shared auth phone' })
    const pairingId = pairing.id
    assert.ok(pairingId)
    assert.ok(pairing.code)
    let banner = $('.mobile-companion-pairing-banner')
    await banner.waitForDisplayed()
    assert.equal(await banner.$('.mobile-companion-pairing-code').getText(), pairing.code)
    assert.equal(await banner.$('button=Allow control').isEnabled(), false)
    await saveElementScreenshot('.mobile-companion-pairing-banner', 'mobile-auth-pairing.png', {
      beforeCapture: async () => {
        await browser.execute(() => {
          const code = document.querySelector('.mobile-companion-pairing-code')
          if (code) code.textContent = '123456'
        })
      },
    })
    await banner.$('button=Read only').click()
    await banner.waitForDisplayed({ reverse: true })
    let pairedToken = ''
    await browser.waitUntil(() => {
      const result = request(`/api/pair/result?id=${pairingId}`)
      pairedToken = result.token ?? ''
      return result.state === 'approved' && Boolean(pairedToken)
    })
    assert.match(request(`/api/pair/result?id=${pairingId}`).error ?? '', /expired/)
    assert.equal(request('/api/activity', undefined, pairedToken).access, 'read')
    assert.match(request('/api/action', {}, pairedToken).error ?? '', /Enable control/)
    // The real service publishes the newly issued credential after durable storage.
    await expect($('.mobile-companion-device-list')).toHaveText(
      expect.stringContaining('Shared auth phone'),
    )
    await browser.reloadSession()
    enabled = $('input[name="mobileCompanionEnabled"]')
    banner = $('.mobile-companion-pairing-banner')
    await $('.prompt-input').waitForExist({ timeout: 30000 })
    await browser.waitUntil(
      () => {
        try {
          return request('/api/activity', undefined, pairedToken).access === 'read'
        } catch {
          return false
        }
      },
      { timeout: 30000 },
    )
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="experimental"]').click()
    await enabled.scrollIntoView({ block: 'center' })
    // Select by visible label, then operate the real device row's revoke control.
    const label = $('strong=Shared auth phone')
    await label.waitForDisplayed()
    await label.parentElement().parentElement().$('.mobile-companion-device-revoke').click()
    await browser.waitUntil(() => Boolean(request('/api/activity', undefined, pairedToken).error))
    assert.match(request('/api/activity', undefined, pairedToken).error ?? '', /Pair this phone/)
    const pending = request('/api/pair/request', { label: 'Cancelled auth phone' })
    assert.ok(pending.id)
    await banner.waitForDisplayed()
    await enabled.click()
    await banner.waitForDisplayed({ reverse: true })
    assert.equal(await enabled.isSelected(), false)
    await saveElementScreenshot(
      'fieldset:has(input[name="mobileCompanionEnabled"])',
      'mobile-auth-pairing-stopped.png',
      {
        beforeCapture: async () => {
          await browser.execute(() => {
            const select = document.querySelector<HTMLSelectElement>(
              'select[name="mobileCompanionAddress"]',
            )
            const option = select?.selectedOptions.item(0)
            if (option) option.textContent = 'Test network — 192.168.1.41'
          })
        },
      },
    )
    await $('select[name="mobileCompanionAddress"]').selectByAttribute(
      'value',
      new URL(origin).hostname,
    )
    await enabled.click()
    await browser.waitUntil(
      () => {
        try {
          return Boolean(request('/api/activity').sessionId)
        } catch {
          return false
        }
      },
      { timeout: 30000 },
    )
    assert.match(request(`/api/pair/result?id=${pending.id}`).error ?? '', /expired/)
    assert.equal(await label.isExisting(), false)
    assert.equal(
      (await $('.mobile-companion-device-list').getText()).includes('Cancelled auth phone'),
      false,
    )
  })
})
