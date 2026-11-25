import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { join } from 'node:path'
import { z } from 'zod'
import QRCode from 'qrcode'
import { $, browser, expect } from '@wdio/globals'
import { fromBase64Url } from '@copse/remote-protocol/encoding.ts'
import { verifyGrantSignature } from '@copse/remote-protocol/grant.ts'
import { LabelGrant } from '@copse/remote-protocol/messages.ts'
import { decodeWithSchema, safeJsonParse } from '../../packages/std/src/safe-json.ts'
import { copseDataRoot } from '../../src/main/services/storage/copse-paths.ts'
import { startFakeRelay, type FakeRelay } from '../helpers/fake-relay.ts'
import { E2E_NAMES_API_PORT, E2E_RELAY, writeE2eEnv } from './helpers/e2e-env.ts'
import { startFakeNamesApi, type FakeNamesApi } from './helpers/fake-names-api.ts'
import { availableMobileAddress } from './helpers/mobile-address.ts'
import { pinTextForCapture, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { ensureTrustedName } from './helpers/trusted-name.ts'

/**
 * Phase 2 remote access, end to end: with a trusted name, the user turns on
 * "reach this Mac from anywhere", Copse opens its tunnel to a stand-in relay
 * that verifies the device-key signature, and a "browser" on another network
 * completes TLS against the Mac's own certificate through that tunnel. The
 * relayed path serves only `web.<label>.u.copse.me`, lets only the copse.me
 * shell frame it, needs a token for everything past pairing, and pairs on the
 * desktop's approval. The one-time copse.me code is a grant the device key
 * signed.
 */

const invite = 'e2e-relay-invite'
const label = 'abcdefgh2345'
const web = `web.${label}.u.copse.me`
const lan = `lan.${label}.u.copse.me`
const projectId = 'e2e-mobile-relay'
const lanRoot = join(copseDataRoot(), 'lan')

const jsonSchema = z.object({
  id: z.string().optional(),
  code: z.string().optional(),
  state: z.string().optional(),
  token: z.string().optional(),
  access: z.string().optional(),
  error: z.string().optional(),
})

function pinRelayName(): Promise<() => Promise<void>> {
  return pinTextForCapture('.mobile-companion-relay-status', /localhost:\d+/, 'relay.copse.dev')
}

describe('Mobile Companion through the relay', function () {
  this.timeout(180_000)
  let api: FakeNamesApi
  let relay: FakeRelay
  let address = ''

  /** A JSON POST to the `lan.` name over real TLS on the local address, as a phone at the desk. */
  const lanPost = (path: string, body: object): Promise<{ status: number; json: unknown }> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: address,
          port: 42773,
          servername: lan,
          ca: api.caPem,
          path,
          method: 'POST',
          headers: {
            host: `${lan}:42773`,
            origin: `https://${lan}:42773`,
            'content-type': 'application/json',
          },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              json: safeJsonParse(
                Buffer.concat(chunks).toString('utf8'),
                decodeWithSchema(jsonSchema),
              ),
            })
          })
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })

  /** The framing headers of the `lan.` name's page, over real TLS on the local address. */
  const lanFraming = (): Promise<{ csp: string; xfo: string | undefined }> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: address,
          port: 42773,
          servername: lan,
          ca: api.caPem,
          path: '/',
          headers: { host: `${lan}:42773` },
          agent: false,
        },
        (res) => {
          res.resume()
          const xfo = res.headers['x-frame-options']
          resolve({
            csp: String(res.headers['content-security-policy']),
            xfo: typeof xfo === 'string' ? xfo : undefined,
          })
        },
      )
      req.on('error', reject)
      req.end()
    })

  const relayed = async (
    path: string,
    options: { body?: object; bearer?: string; host?: string; clientIp?: string } = {},
  ): Promise<{
    status: number
    headers: Record<string, unknown>
    json: z.infer<typeof jsonSchema> | null
    body: string
  }> => {
    const headers: Record<string, string> = { origin: `https://${web}` }
    if (options.host) headers['host'] = options.host
    if (options.bearer) headers['authorization'] = `Bearer ${options.bearer}`
    if (options.body) headers['content-type'] = 'application/json'
    const response = await relay.browserRequest({
      serverName: web,
      ca: api.caPem,
      path,
      method: options.body ? 'POST' : 'GET',
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(options.clientIp ? { clientIp: options.clientIp } : {}),
    })
    return {
      ...response,
      json: safeJsonParse(response.body, decodeWithSchema(jsonSchema)),
    }
  }

  /**
   * Leave the relay chosen and its tunnel connected, from whatever state the
   * previous test left, so each test also passes when run alone.
   */
  const ensureRelayOn = async (): Promise<void> => {
    await ensureTrustedName(invite, lan)
    const block = $('.mobile-companion-relay')
    await block.scrollIntoView({ block: 'center' })
    const toggle = block.$('input[name="mobileCompanionRelay"]')
    if (!(await toggle.isSelected())) await toggle.click()
    await relay.waitForTunnel(30_000)
    await expect(block.$('.mobile-companion-relay-status')).toHaveText(
      expect.stringContaining(`Connected to localhost:${String(relay.port)}`),
      { wait: 15_000 },
    )
  }

  before(async () => {
    const found = await availableMobileAddress()
    assert.ok(found, 'The relay eval requires an unused private IPv4 interface on port 42773')
    address = found
    api = await startFakeNamesApi({ port: E2E_NAMES_API_PORT, invite, label })
    relay = await startFakeRelay({
      hostname: 'localhost',
      deviceKey: (name) => Promise.resolve(name === label ? api.deviceKey() : null),
    })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), projectId, {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
    })
    mkdirSync(lanRoot, { recursive: true, mode: 0o700 })
    writeFileSync(join(lanRoot, 'service.json'), JSON.stringify({ enabled: true, address }), {
      mode: 0o600,
    })
    // The e2e shell adds the stand-in relay's root to Node's default CA set at
    // the TLS boundary (bootstrap.cjs); nothing in Copse knows about it.
    const caFile = join(copseDataRoot(), 'e2e-relay-ca.pem')
    writeFileSync(caFile, relay.caPem)
    writeE2eEnv({
      COPSE_RELAY: `localhost:${String(relay.port)}`,
      COPSE_E2E_EXTRA_CA_CERTS: caFile,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    writeE2eEnv({ COPSE_RELAY: E2E_RELAY, COPSE_E2E_EXTRA_CA_CERTS: undefined })
    await relay.close()
    await api.close()
    resetUserData()
  })

  it('opens the tunnel once chosen, and serves the web name through it', async () => {
    await ensureTrustedName(invite, lan)

    // Off until the user chooses it: no tunnel yet.
    const block = $('.mobile-companion-relay')
    await expect(block).toBeDisplayed()
    const toggle = block.$('input[name="mobileCompanionRelay"]')
    assert.equal(await toggle.isSelected(), false)
    assert.equal(relay.tunnels(), 0)
    // Nothing may frame the trusted name until the relay is chosen.
    const before = await lanFraming()
    assert.match(before.csp, /frame-ancestors 'none'/)
    assert.equal(before.xfo, 'DENY')

    await toggle.click()
    await relay.waitForTunnel(30_000)
    assert.deepEqual(relay.authenticated, [label])
    assert.deepEqual(relay.refused, [])
    const status = block.$('.mobile-companion-relay-status')
    await expect(status).toHaveText(
      expect.stringContaining(`Connected to localhost:${String(relay.port)}`),
      {
        wait: 15_000,
      },
    )
    await expect(status).toHaveText(expect.stringContaining(web))
    await block.scrollIntoView({ block: 'center' })
    // The stand-in relay listens on a free port; capture the production relay's name.
    const restoreRelay = await pinRelayName()
    try {
      await saveElementScreenshot('.mobile-companion-relay', 'mobile-relay-connected.png')
    } finally {
      await restoreRelay()
    }

    // A browser elsewhere: TLS ends on the Mac, verified against the label's certificate.
    const page = await relayed('/')
    assert.equal(page.status, 200)
    assert.match(page.body, /<html/i)
    assert.match(
      String(page.headers['content-security-policy']),
      /frame-ancestors https:\/\/copse\.me(;|$)/,
    )
    assert.equal(page.headers['x-frame-options'], undefined)
    // Once chosen, the lan. name is framable by the shell too, and the diagram frame admits it.
    const after = await lanFraming()
    assert.match(after.csp, /frame-ancestors https:\/\/copse\.me(;|$)/)
    assert.equal(after.xfo, undefined)
    const diagram = await relayed('/mermaid-frame.html')
    assert.equal(
      diagram.headers['content-security-policy'],
      "frame-ancestors 'self' https://copse.me",
    )
    assert.equal(diagram.headers['x-frame-options'], undefined)

    // Everything past pairing needs a token, and only the web name is served.
    assert.equal((await relayed('/api/activity')).status, 401)
    assert.equal((await relayed('/', { host: `${lan}:42773` })).status, 403)
    assert.equal((await relayed('/', { host: 'web.zzzzzzzzzzzz.u.copse.me' })).status, 403)
  })

  it('pairs a relayed phone on the desktop approval, and says it came through copse.me', async () => {
    await ensureRelayOn()
    const started = await relayed('/api/pair/request', {
      body: { label: 'Away phone' },
      clientIp: '198.51.100.40',
    })
    assert.ok(started.json?.id && started.json.code, started.json?.error ?? 'pairing did not start')
    const banner = $('.mobile-companion-pairing-banner')
    await banner.scrollIntoView({ block: 'center' })
    await expect(banner).toHaveText(expect.stringContaining(started.json.code), { wait: 15_000 })
    await expect(banner).toHaveText(expect.stringContaining('through the Copse relay (copse.me)'))
    const restoreCode = await pinTextForCapture(
      '.mobile-companion-pairing-code',
      /^\d{6}$/,
      '123456',
    )
    try {
      await saveElementScreenshot('.mobile-companion-pairing-banner', 'mobile-relay-pairing.png')
    } finally {
      await restoreCode()
    }
    await banner.$('button=Allow control').click()

    // Collected through the relay by whoever holds the pairing's random id, even from
    // another address: a phone's reported address can change between request and poll.
    let token = ''
    await browser.waitUntil(
      async () => {
        const result = await relayed(`/api/pair/result?id=${started.json?.id ?? ''}`, {
          clientIp: '2001:db8::5',
        })
        token = result.json?.token ?? ''
        return token !== ''
      },
      { timeout: 15_000, interval: 500 },
    )
    const feed = await relayed('/api/activity', { bearer: token })
    assert.equal(feed.status, 200)
    assert.equal(feed.json?.access, 'control')
  })

  it('keeps pairing open to the local network while a relayed request is pending', async () => {
    await ensureRelayOn()
    // Each slot takes one request a second, and after the previous test its request was moments
    // ago: retry briefly. A slot still held by an earlier pairing would stay busy for two minutes.
    let away: Awaited<ReturnType<typeof relayed>> | undefined
    await browser.waitUntil(
      async () => {
        away = await relayed('/api/pair/request', {
          body: { label: 'Relay squatter' },
          clientIp: '198.51.100.41',
        })
        return away.status !== 429
      },
      { timeout: 5000, interval: 300, timeoutMsg: 'the relayed pairing slot stayed busy' },
    )
    assert.equal(away?.status, 200, `the relayed request took its own slot: ${away?.body ?? ''}`)
    const banner = $('.mobile-companion-pairing-banner')
    await expect(banner).toHaveText(expect.stringContaining('Relay squatter'), { wait: 15_000 })
    // A phone at the desk is not told "Pairing already in progress"…
    const desk = await lanPost('/api/pair/request', { label: 'Desk phone' })
    assert.equal(desk.status, 200)
    // …and it replaces the relayed request on the desktop.
    await expect(banner).toHaveText(expect.stringContaining('Desk phone'), { wait: 15_000 })
    await banner.$('button=Deny').click()
    await expect(banner).not.toBeDisplayed({ wait: 15_000 })
  })

  it('shows a one-time copse.me code signed by the device key', async () => {
    await ensureRelayOn()
    const block = $('.mobile-companion-relay')
    await block.scrollIntoView({ block: 'center' })
    await block.$('button=Add this Mac at copse.me').click()
    const qr = $('#mobile-companion-shell-qr')
    await expect(qr).toBeDisplayed({ wait: 15_000 })

    const url = await browser.execute(
      async () => (await window.api.mobile.getState()).shellPairing?.url ?? '',
    )
    const match = /^https:\/\/copse\.me\/add#g=([A-Za-z0-9_-]+)$/.exec(url)
    assert.ok(match?.[1], `unexpected pairing URL ${url}`)
    const bytes = fromBase64Url(match[1])
    assert.ok(bytes)
    const grant = safeJsonParse(new TextDecoder().decode(bytes), decodeWithSchema(LabelGrant))
    assert.ok(grant)
    assert.equal(grant.label, label)
    const key = api.deviceKey()
    assert.ok(key)
    assert.equal(
      await verifyGrantSignature(key, grant),
      true,
      'the grant verifies with the device key',
    )

    // The QR shown is exactly that link.
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1 })
    assert.equal(
      await browser.execute((expected) => {
        const reference = document.createElement('div')
        reference.innerHTML = expected
        return (
          document.querySelector('#mobile-companion-shell-qr .mobile-companion-qr-image')
            ?.innerHTML === reference.innerHTML
        )
      }, svg),
      true,
    )

    // Each grant is random: capture a fixed one, and a fixed expiry time.
    const fixed = await QRCode.toString(`https://copse.me/add#g=${'A'.repeat(230)}`, {
      type: 'svg',
      margin: 1,
    })
    await browser.execute((replacement) => {
      const host = document.querySelector('#mobile-companion-shell-qr .mobile-companion-qr-image')
      if (host) host.innerHTML = replacement
    }, fixed)
    const restoreExpiry = await pinTextForCapture(
      '#mobile-companion-shell-qr .field-hint',
      /expires at .+\.$/,
      'expires at 10:42 AM.',
    )
    const restoreRelay = await pinRelayName()
    try {
      await saveElementScreenshot('.mobile-companion-relay', 'mobile-relay-shell-code.png')
    } finally {
      await restoreRelay()
      await restoreExpiry()
    }
    await qr.$('button=Done').click()
    await expect(qr).not.toBeDisplayed({ wait: 15_000 })
  })

  it('closes the tunnel when turned off', async () => {
    await ensureRelayOn()
    const block = $('.mobile-companion-relay')
    await block.$('input[name="mobileCompanionRelay"]').click()
    await browser.waitUntil(() => relay.tunnels() === 0, {
      timeout: 15_000,
      timeoutMsg: 'the tunnel stayed open after the relay was turned off',
    })
    await expect(block.$('.mobile-companion-relay-status')).toHaveText('', { wait: 15_000 })
    await expect(block.$('button=Add this Mac at copse.me')).not.toBeDisplayed()
  })
})
