import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import QRCode from 'qrcode'
import { $, browser, expect } from '@wdio/globals'
import { decodeWithSchema, safeJsonParse } from '../../packages/std/src/safe-json.ts'
import { copseDataRoot } from '../../src/main/services/storage/copse-paths.ts'
import { E2E_NAMES_API_PORT } from './helpers/e2e-env.ts'
import { startFakeNamesApi, type FakeNamesApi } from './helpers/fake-names-api.ts'
import { pinTextForCapture, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'

/**
 * Phase 1 remote access, end to end against a stand-in names API: redeem an
 * invite in Settings, then prove over real TLS that the Mobile Companion
 * presents the issued chain for `lan.<label>.u.copse.me` (and still the local
 * root for the bare IP), and that pairing over the trusted name grants control
 * on the desktop approval alone. The stand-in verifies every request signature.
 */

const invite = 'e2e-invite-7'
const label = 'abcdefgh2345'
const hostname = `lan.${label}.u.copse.me`
const projectId = 'e2e-mobile-trusted-name'
const lanRoot = join(copseDataRoot(), 'lan')

const addresses = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter(
    (entry) =>
      entry.family === 'IPv4' &&
      !entry.internal &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
  )
  .map((entry) => entry.address)

async function availableAddress(): Promise<string | undefined> {
  // A daily Copse may already own the stable port on one interface. Probe only
  // availability; never stop it or send requests to an unrelated profile.
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

const pairSchema = z.object({
  id: z.string().optional(),
  code: z.string().optional(),
  state: z.string().optional(),
  token: z.string().optional(),
  access: z.string().optional(),
  error: z.string().optional(),
})

function curl(args: string[], input?: string): string {
  return execFileSync(
    '/usr/bin/curl',
    ['--silent', '--show-error', '--noproxy', '*', '--max-time', '20', ...args],
    { encoding: 'utf8', ...(input === undefined ? {} : { input }) },
  )
}

async function expectQrForUrl(selector: string, url: string): Promise<void> {
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1 })
  assert.equal(
    await browser.execute(
      (target, expected) => {
        const reference = document.createElement('div')
        reference.innerHTML = expected
        return document.querySelector(target)?.innerHTML === reference.innerHTML
      },
      selector,
      svg,
    ),
    true,
    `the visible QR must encode ${url}`,
  )
}

describe('Mobile Companion trusted name', function () {
  this.timeout(180_000)
  let api: FakeNamesApi
  let address = ''
  let caFile = ''
  const origin = `https://${hostname}:42773`
  const viaName = (): string[] => ['--resolve', `${hostname}:42773:${address}`, '--cacert', caFile]
  const nameRequest = (
    path: string,
    body?: object,
    bearer?: string,
  ): z.infer<typeof pairSchema> => {
    const args = [...viaName(), '-H', `Origin: ${origin}`]
    if (bearer) args.push('-H', `Authorization: Bearer ${bearer}`)
    if (body) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-')
    const parsed = safeJsonParse(
      curl([...args, `${origin}${path}`], body ? JSON.stringify(body) : undefined),
      decodeWithSchema(pairSchema),
    )
    assert.ok(parsed, `${path} returned JSON`)
    return parsed
  }

  before(async () => {
    const found = await availableAddress()
    assert.ok(
      found,
      'The trusted-name eval requires an unused private IPv4 interface on port 42773',
    )
    address = found
    api = await startFakeNamesApi({ port: E2E_NAMES_API_PORT, invite, label })
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), projectId, {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
    })
    mkdirSync(lanRoot, { recursive: true, mode: 0o700 })
    writeFileSync(join(lanRoot, 'service.json'), JSON.stringify({ enabled: true, address }), {
      mode: 0o600,
    })
    caFile = join(copseDataRoot(), 'e2e-names-ca.pem')
    writeFileSync(caFile, api.caPem)
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    await api.close()
    resetUserData()
  })

  it('redeems an invite and serves the issued certificate for the trusted name', async () => {
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="experimental"]').click()
    const card = $('.mobile-companion-name')
    await card.scrollIntoView({ block: 'center' })
    await expect(card).toBeDisplayed()
    const inviteInput = card.$('input[name="mobileCompanionInvite"]')
    await expect(inviteInput).toBeDisplayed()
    await saveElementScreenshot('.mobile-companion-name', 'mobile-trusted-name-unregistered.png')

    await inviteInput.setValue(invite)
    await card.$('button=Get a name').click()
    await expect(card.$('.mobile-companion-name-summary strong')).toHaveText(hostname, {
      wait: 30_000,
    })
    await browser.waitUntil(async () => /Certificate valid until/.test(await card.getText()), {
      timeout: 30_000,
      timeoutMsg: 'the certificate never arrived',
    })
    assert.deepEqual(api.refused, [], 'every request to the names API was correctly signed')
    for (const call of ['POST /v1/register', 'POST /v1/address', 'POST /v1/certificate'])
      assert.ok(api.verified.includes(call), `${call} was sent and verified`)
    assert.deepEqual(api.addresses, [address])

    // The connection block now leads with the trusted name.
    const connection = $('.mobile-companion-connection')
    await expect(connection).toHaveText(expect.stringContaining(origin), {
      wait: 15_000,
    })
    await expect(connection).toHaveText(expect.stringContaining(`https://${address}:42773`))

    // Over real TLS: the name gets the issued chain, the bare IP the local root.
    assert.match(curl([...viaName(), `${origin}/`]), /<html/i)
    assert.match(curl(['--cacert', join(lanRoot, 'ca.crt'), `https://${address}:42773/`]), /<html/i)
    // Another name on the same address is still refused by the Host check.
    const otherHost = curl([
      ...viaName(),
      '-H',
      'Host: lan.zzzzzzzzzzzz.u.copse.me:42773',
      `${origin}/`,
    ])
    assert.match(otherHost, /Forbidden/)

    // A fake label never resolves in the public zone, so the card explains the
    // DNS case and leads with the local-address QR.
    await browser.waitUntil(async () => /does not answer for/.test(await card.getText()), {
      timeout: 30_000,
    })
    await expect($('#mobile-companion-local-qr')).toBeDisplayed({
      wait: 15_000,
    })
    await expectQrForUrl(
      '#mobile-companion-local-qr .mobile-companion-qr-image',
      `https://${address}:42773`,
    )
    await card.scrollIntoView({ block: 'center' })
    // TLS assertions above keep the real issued certificate. Pin only its
    // wall-clock display while capturing, then restore it for subsequent work.
    const restoreCertificate = await pinTextForCapture(
      '.mobile-companion-name-summary .field-hint',
      /^Certificate valid until .+$/,
      'Certificate valid until Nov 5, 5:35 AM · renews from Nov 2, 4:40 PM. Copse renews it while open.',
    )
    try {
      await saveElementScreenshot('.mobile-companion-name', 'mobile-trusted-name-registered.png')
    } finally {
      await restoreCertificate()
    }

    // Exercise the real QR switch instead of replacing its graphic: the name
    // is fixed by the fixture, while the local address must remain host-specific
    // for the real TLS checks. Both QR URLs are asserted before capture.
    await connection.$('button=Show the trusted-name QR').click()
    await expect($('#mobile-companion-qr')).toBeDisplayed()
    await expect($('#mobile-companion-local-qr')).not.toBeDisplayed()
    await expectQrForUrl('#mobile-companion-qr .mobile-companion-qr-image', origin)
    await connection.scrollIntoView({ block: 'center' })
    const restoreAddress = await pinTextForCapture(
      '.mobile-companion-connection',
      new RegExp(address.replaceAll('.', '\\.'), 'g'),
      '10.1.0.31',
    )
    try {
      await saveElementScreenshot(
        '.mobile-companion-connection',
        'mobile-trusted-name-connection.png',
      )
    } finally {
      await restoreAddress()
    }
    await expect(connection).toHaveText(expect.stringContaining(`https://${address}:42773`))
  })

  it('grants control on the desktop approval alone when a phone pairs over the name', async () => {
    const started = nameRequest('/api/pair/request', {
      label: 'Trusted-name phone',
    })
    assert.ok(started.id && started.code, started.error ?? 'pairing did not start')
    const banner = $('.mobile-companion-pairing-banner')
    await banner.scrollIntoView({ block: 'center' })
    await expect(banner).toHaveText(expect.stringContaining(started.code), {
      wait: 15_000,
    })
    assert.equal(await banner.$('input[type="checkbox"]').isExisting(), false)
    await expect(banner).toHaveText(expect.stringContaining('trusted name'))
    const restoreCode = await pinTextForCapture(
      '.mobile-companion-pairing-code',
      /^\d{6}$/,
      '123456',
    )
    try {
      await saveElementScreenshot(
        '.mobile-companion-pairing-banner',
        'mobile-trusted-name-pairing.png',
      )
    } finally {
      await restoreCode()
    }
    await expect(banner.$('.mobile-companion-pairing-code')).toHaveText(started.code)
    await banner.$('button=Allow control').click()

    let token = ''
    await browser.waitUntil(
      () => {
        const result = nameRequest(`/api/pair/result?id=${started.id ?? ''}`)
        token = result.token ?? ''
        return token !== ''
      },
      { timeout: 15_000, interval: 500 },
    )
    assert.equal(nameRequest('/api/activity', undefined, token).access, 'control')
  })

  it('removes the name from the service and offers the invite again', async () => {
    const card = $('.mobile-companion-name')
    await card.scrollIntoView({ block: 'center' })
    await card.$('button=Remove name').click()
    await expect(card.$('input[name="mobileCompanionInvite"]')).toBeDisplayed({
      wait: 15_000,
    })
    assert.ok(api.verified.includes('DELETE /v1/device'))
    // The trusted name is no longer served once its record is gone.
    const connection = $('.mobile-companion-connection')
    await expect(connection).not.toHaveText(expect.stringContaining(hostname), {
      wait: 15_000,
    })
  })
})
