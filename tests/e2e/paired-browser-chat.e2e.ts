import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { remote, type Browser } from 'webdriverio'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { copseDataRoot } from '../../src/main/services/storage/copse-paths.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  e2eWorkspaceDir,
} from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { shouldUseChromiumHeadless } from './helpers/display-mode.mts'
import { withFrozenAnimations } from './helpers/frozen-animations.ts'
import { E2E_SCREENSHOT_DIR } from './helpers/screenshot.ts'
import { acceptProtectedPrompt } from './helpers/composer.ts'

const projectId = 'e2e-paired-browser'
const deviceLabel = 'Paired browser acceptance'
let phone: Browser | undefined
let origin = ''
let threadId = ''
let fixtureDir = ''
let token = ''
const fixtureReply = z.object({
  id: z.string(),
  type: z.literal('request'),
  ok: z.boolean(),
  visible: z.boolean().optional(),
  error: z.string().optional(),
})

async function native(
  action: 'close' | 'activate' | 'window-state',
): Promise<z.infer<typeof fixtureReply>> {
  const id = randomUUID()
  writeFileSync(join(fixtureDir, 'request.json'), JSON.stringify({ id, action }))
  const read = (): z.infer<typeof fixtureReply> | undefined => {
    const path = join(fixtureDir, 'events.jsonl')
    return existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .flatMap((line) => {
            const entry = safeJsonParse(line, decodeWithSchema(fixtureReply))
            return entry?.id === id ? [entry] : []
          })[0]
      : undefined
  }
  await browser.waitUntil(() => read() !== undefined, { timeout: 10_000, interval: 50 })
  const reply = read()
  assert.ok(reply)
  assert.equal(reply.ok, true, reply.error ?? 'Native request failed')
  return reply
}

function privateAddress(): string {
  const entry = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .find(
      (candidate) =>
        candidate.family === 'IPv4' &&
        !candidate.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(candidate.address),
    )
  if (!entry) throw new Error('Paired-browser acceptance needs a private IPv4 address')
  return entry.address
}

/**
 * The Mobile Companion binds a fixed product port, so another Copse on this
 * address (such as the daily app) can hold it. Before the phone connects, the
 * desktop under test must report its own server at `origin`; otherwise the
 * phone would reach that other Copse.
 */
async function expectDesktopServes(origin: string): Promise<void> {
  const url = $('.mobile-companion-connection strong')
  await browser.waitUntil(
    async () => (await url.isExisting()) && (await url.getText()) === origin,
    {
      timeout: 20_000,
      timeoutMsg: `The desktop under test is not serving ${origin}. Another process, such as the daily Copse, may hold the Mobile Companion port on this address; never stop the daily Copse server`,
    },
  )
}

function mobile(): Browser {
  assert.ok(phone)
  return phone
}

async function phoneRequest(
  path: string,
  payload?: object,
): Promise<{ status: number; body: unknown }> {
  return mobile().execute(
    async (input) => {
      const response = await fetch(input.path, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + (localStorage.getItem('copse-mobile-token') ?? ''),
        },
        ...(input.payload === undefined
          ? {}
          : { method: 'POST', body: JSON.stringify(input.payload) }),
      })
      const body: unknown = await response.json()
      return { status: response.status, body }
    },
    { path, ...(payload === undefined ? {} : { payload }) },
  )
}

async function openSettings(): Promise<void> {
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog button[data-section="experimental"]').click()
  await $('input[name="mobileCompanionEnabled"]').scrollIntoView({ block: 'center' })
}

async function send(text: string): Promise<void> {
  const editor = mobile().$('.prompt-input')
  await editor.waitForExist()
  await editor.setValue(text)
  await mobile().$('.submit-btn').waitForEnabled()
  await mobile().$('.submit-btn').click()
  await mobile().waitUntil(async () => (await editor.getText()) === '')
}

async function waitText(text: string): Promise<void> {
  await mobile().waitUntil(
    async () => (await mobile().$('#conversation').getText()).includes(text),
    { timeout: 60_000, timeoutMsg: `Phone never received: ${text}` },
  )
}

function spine(): Array<{ id: string; role: string }> {
  const schema = z.object({ type: z.literal('message'), id: z.string(), role: z.string() })
  const path = join(e2eWorkspaceDir(), projectId, threadId, 'events.jsonl')
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line) => {
          const value = safeJsonParse(line, decodeWithSchema(schema))
          return value ? [value] : []
        })
    : []
}

describe('real paired browser chat with the desktop window closed', function () {
  this.timeout(240_000)
  before(async () => {
    const address = privateAddress()
    origin = `https://${address}:42773`
    fixtureDir = mkdtempSync(join(tmpdir(), 'copse-paired-browser-'))
    writeE2eEnv({ COPSE_E2E_NATIVE_ALERTS: fixtureDir })
    resetUserData()
    seedEmptyProject(seedStableWorkspace({ root: join(fixtureDir, 'project') }), projectId, {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      autoRunSandboxCommands: false,
    })
    const lan = join(copseDataRoot(), 'lan')
    mkdirSync(lan, { recursive: true, mode: 0o700 })
    writeFileSync(join(lan, 'service.json'), JSON.stringify({ enabled: true, address }), {
      mode: 0o600,
    })
    // Pair through the product UI; do not pre-grant a fixture device authority.
    writeFileSync(join(lan, 'devices.json'), '[]', { mode: 0o600 })
    await browser.reloadSession()
    await $('.chat-row.selected').waitForExist()
    const selectedId = await $('.chat-row.selected').getAttribute('data-thread-id')
    assert.ok(selectedId)
    threadId = selectedId
    phone = await remote({
      logLevel: 'warn',
      capabilities: {
        browserName: 'chrome',
        acceptInsecureCerts: true, // This tests transport/control, not a physical phone's trust ceremony.
        'wdio:enforceWebDriverClassic': true,
        'goog:chromeOptions': {
          args: [
            '--headless=new',
            '--no-sandbox',
            '--disable-gpu',
            '--no-proxy-server',
            '--window-size=390,844',
          ],
          ...(process.env['COPSE_DEMO_CHROME_BINARY']
            ? { binary: process.env['COPSE_DEMO_CHROME_BINARY'] }
            : {}),
        },
        ...(process.env['COPSE_DEMO_CHROMEDRIVER_BINARY']
          ? {
              'wdio:chromedriverOptions': { binary: process.env['COPSE_DEMO_CHROMEDRIVER_BINARY'] },
            }
          : {}),
      },
    })
    await mobile().sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    })
    await openSettings()
    await expectDesktopServes(origin)
    await mobile().url(origin)
    const pairingSchema = z.object({ id: z.string(), code: z.string() })
    const pairing = pairingSchema.parse(
      (await phoneRequest('/api/pair/request', { label: deviceLabel })).body,
    )
    const banner = $('.mobile-companion-pairing-banner')
    await banner.waitForDisplayed()
    await expect(banner.$('.mobile-companion-pairing-code')).toHaveText(pairing.code)
    await banner.$('input[type="checkbox"]').click()
    await banner.$('button=Allow control').click()
    const pairedSchema = z.object({ token: z.string() })
    await mobile().waitUntil(async () => {
      const result = pairedSchema.safeParse(
        (await phoneRequest(`/api/pair/result?id=${pairing.id}`)).body,
      )
      if (result.success) token = result.data.token
      return result.success
    })
    await mobile().execute((value) => {
      localStorage.setItem('copse-mobile-token', value)
    }, token)
    await $('#settings-cancel').click()
    await mobile().url(`${origin}/remote/?project=${projectId}&thread=${threadId}`)
    await mobile().$('#connection[data-connected="true"]').waitForExist()
  })

  after(async () => {
    await phone?.deleteSession().catch(() => {})
    await native('activate').catch(() => {})
    await openSettings()
      .then(async () => {
        const enabled = $('input[name="mobileCompanionEnabled"]')
        if (await enabled.isSelected()) await enabled.click()
        await $('#settings-cancel').click()
      })
      .catch(() => {})
    writeE2eEnv({ COPSE_E2E_NATIVE_ALERTS: undefined })
    resetUserData()
  })

  it('sends, queues, answers and approves with no visible desktop, then reopens without duplication', async () => {
    const first = 'Ask which tests to run, then run the approved command.'
    const followup = 'Check the profile permission and report the result.'
    const scenario = await installMockScenario({
      title: 'Paired browser lifecycle',
      turns: [
        {
          user: first,
          responses: [
            {
              text: 'Choosing the tests.',
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
              toolCalls: [{ name: 'run_shell', args: { command: "printf 'phone-approved'" } }],
              expectToolResults: [{ name: 'ask_user', includes: 'Focused tests' }],
            },
            {
              text: 'The approved command completed.',
              expectToolResults: [{ name: 'run_shell', includes: 'phone-approved' }],
            },
          ],
        },
        {
          user: followup,
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
    assert.equal((await native('close')).visible, false, 'Idle close must keep phone access alive')
    // Lose the reply only after the real server has accepted the submission.
    // Retry must reuse its identity, not create a second turn or queued message.
    await mobile().execute(() => {
      const original = window.fetch.bind(window)
      let loseReply = true
      window.fetch = async (input, init): Promise<Response> => {
        const response = await original(input, init)
        if (loseReply && input === '/api/action' && response.ok) {
          loseReply = false
          throw new TypeError('Connection lost after submission')
        }
        return response
      }
    })
    await mobile().$('.prompt-input').setValue(first)
    await mobile().$('.submit-btn').click()
    await mobile().$('.remote-send-error:not([hidden])').waitForDisplayed()
    assert.equal(await mobile().$('.prompt-input').getText(), first)
    await mobile().$('.submit-btn').click()
    await mobile().waitUntil(async () => (await mobile().$('.prompt-input').getText()) === '')
    await acceptProtectedPrompt()
    await mobile().$('.remote-decision textarea').waitForExist()
    await mobile().$('button=Focused tests').click()
    await send(followup)
    await mobile().$('button=Send answers').click()
    await acceptProtectedPrompt()
    await mobile().$('button=Approve').waitForExist()
    await mobile().$('button=Approve').click()
    await waitText('The approved command completed.')
    await mobile().$('button=Deny').waitForExist()
    // The decision card and the transcript arrive on separate polls. Capture
    // once the transcript shows the pending command, not the step before it.
    await mobile().waitUntil(
      async () => {
        const transcript = await mobile().$('#conversation').getText()
        return transcript.includes('ls -la ~/.copse') && transcript.includes('Waiting for approval')
      },
      { timeout: 15_000, timeoutMsg: 'The phone transcript never showed the pending profile read' },
    )
    // The earlier Approve click leaves the pointer where this card's Approve
    // button can land; move it off the controls so hover stays out of the shot.
    await mobile().action('pointer').move({ x: 1, y: 1 }).perform()
    // Full phone viewport is the subject, not Electron's #app screenshot frame.
    const shots =
      process.platform === 'darwin'
        ? join(process.cwd(), 'e2e-failure-artifacts', 'paired-browser')
        : E2E_SCREENSHOT_DIR
    mkdirSync(shots, { recursive: true })
    for (const [theme, filename] of [
      ['light', 'paired-browser-approval-light.png'],
      ['dark', 'paired-browser-approval-dark.png'],
    ] as const) {
      await mobile().sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      })
      await mobile().waitUntil(
        async () => (await mobile().$('html').getAttribute('data-theme')) === theme,
      )
      assert.equal(
        await mobile().execute(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      )
      await mobile().execute(async () => {
        await document.fonts.ready
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve()
            })
          }),
        )
      })
      assert.equal(await mobile().$('.submit-btn').getText(), 'Queue')
      await withFrozenAnimations(async () => {
        await mobile().saveScreenshot(join(shots, filename))
      }, mobile())
    }
    await mobile().$('button=Deny').click()
    await waitText('The phone declined the profile read.')
    await scenario.assertComplete()
    assert.equal((await native('window-state')).visible, false)
    // Active snapshots alone cannot prove the real main/preload read relay works.
    const transcript = await phoneRequest('/api/remote/read', {
      version: 1,
      channel: 'threads:load-messages',
      args: [projectId, threadId],
    })
    assert.equal(transcript.status, 200)
    const loaded = z
      .object({ value: z.array(z.object({ id: z.string(), role: z.string() })) })
      .parse(transcript.body).value
    assert.deepEqual(
      loaded.map((message) => message.id),
      spine().map((message) => message.id),
    )
    assert.equal(loaded.filter((message) => message.role === 'user').length, 2)
    const ids = await mobile()
      .$$('.msg')
      .map(async (node) => node.getAttribute('data-message-id'))
    await native('activate')
    await $('.prompt-input').waitForDisplayed()
    await browser.waitUntil(async () =>
      (await $('#conversation').getText()).includes('The phone declined the profile read.'),
    )
    const before = spine()
    assert.equal(new Set(before.map((message) => message.id)).size, before.length)
    assert.equal(before.filter((message) => message.role === 'user').length, 2)
    assert.deepEqual(
      await mobile()
        .$$('.msg')
        .map(async (node) => node.getAttribute('data-message-id')),
      ids,
    )
    assert.equal((await native('window-state')).visible, !shouldUseChromiumHeadless())
  })

  it('preserves drafts through network loss, stops a run, and blocks downgraded or revoked credentials', async () => {
    const scenario = await installMockScenario({
      title: 'Paired browser stop',
      turns: [
        {
          user: 'Wait until I stop this run from my phone.',
          allowAbort: true,
          responses: [{ waitFor: 'phone-stop', text: 'This run should be interrupted.' }],
        },
      ],
    })
    await send('Wait until I stop this run from my phone.')
    await acceptProtectedPrompt()
    await scenario.waitForHold('phone-stop')
    await mobile().$('.stop-btn').waitForDisplayed()
    await mobile().$('.prompt-input').setValue('Keep this unsent draft.')
    await mobile().sendCommand('Network.enable', {})
    await mobile().sendCommand('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await mobile().$('#connection[data-connected="false"]').waitForExist()
    assert.equal(await mobile().$('.submit-btn').isEnabled(), false)
    await mobile().sendCommand('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    await mobile().$('#connection[data-connected="true"]').waitForExist()
    assert.equal(await mobile().$('.prompt-input').getText(), 'Keep this unsent draft.')
    await mobile().$('.stop-btn').click()
    await scenario.assertComplete()
    await openSettings()
    const row = $('strong=' + deviceLabel)
      .parentElement()
      .parentElement()
    await row.$('button=Make read only').click()
    await mobile().$('#connection[data-connected="false"]').waitForExist()
    assert.equal((await phoneRequest('/api/action', {})).status, 403)
    const transcriptRead = {
      version: 1,
      channel: 'threads:load-messages',
      args: [projectId, threadId],
    }
    assert.equal((await phoneRequest('/api/remote/read', transcriptRead)).status, 403)
    await row.$('input[type="checkbox"]').click()
    await row.$('button=Allow control').click()
    await mobile().$('#connection[data-connected="true"]').waitForExist()
    await row.$('.mobile-companion-device-revoke').click()
    await mobile().$('#connection[data-connected="false"]').waitForExist()
    assert.equal((await phoneRequest('/api/activity')).status, 401)
    assert.equal((await phoneRequest('/api/remote/read', transcriptRead)).status, 401)
    assert.equal(await mobile().$('.submit-btn').isEnabled(), false)
    assert.equal(await mobile().$('.prompt-input').getText(), 'Keep this unsent draft.')
    await $('#settings-cancel').click()
  })
})
