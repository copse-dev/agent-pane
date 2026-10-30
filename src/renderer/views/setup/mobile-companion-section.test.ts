import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../../preload/api.d.ts'
import type {
  MobileCompanionAccess,
  MobileCompanionPublicName,
  MobileCompanionState,
} from '../../../shared/types/mobile-companion.ts'
import { createMobileCompanionSection } from './mobile-companion-section.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'

const unregistered: MobileCompanionPublicName = {
  serviceUrl: 'https://api.copse.dev',
  state: 'unregistered',
  hostname: null,
  certificate: null,
  dns: 'unknown',
  busy: null,
  lastError: null,
}

const hostname = 'lan.abcdefgh2345.u.copse.me'
const registered: MobileCompanionPublicName = {
  ...unregistered,
  state: 'active',
  hostname,
  certificate: { notAfter: Date.now() + 5 * 86_400_000, renewAt: Date.now() + 3 * 86_400_000 },
  dns: 'ok',
}

function mockApi(initial: Partial<MobileCompanionState> = {}): {
  api: ApiClient
  state: MobileCompanionState
  calls: {
    enable: string[]
    disable: number
    setAccess: Array<{
      id: string
      access: MobileCompanionAccess
      rootTrusted: boolean | undefined
    }>
    revoke: string[]
    pairing: Array<{
      decision: MobileCompanionAccess | 'deny'
      code: string
      pairingId: string
      rootTrusted: boolean | undefined
    }>
    revealed: number
    registerName: string[]
    removeName: number
    recheckNameDns: number
  }
  push: (patch: Partial<MobileCompanionState>) => void
} {
  const state: MobileCompanionState = {
    enabled: false,
    running: false,
    url: null,
    qrSvg: null,
    localUrl: null,
    localQrSvg: null,
    publicName: unregistered,
    rootCertificatePath: null,
    address: null,
    addresses: [{ address: '192.168.1.5', interfaceName: 'en0', virtual: false }],
    devices: [],
    pairing: null,
    lastError: null,
    ...initial,
  }
  const calls = {
    enable: [] as string[],
    disable: 0,
    setAccess: [] as Array<{
      id: string
      access: MobileCompanionAccess
      rootTrusted: boolean | undefined
    }>,
    revoke: [] as string[],
    pairing: [] as Array<{
      decision: MobileCompanionAccess | 'deny'
      code: string
      pairingId: string
      rootTrusted: boolean | undefined
    }>,
    revealed: 0,
    registerName: [] as string[],
    removeName: 0,
    recheckNameDns: 0,
  }
  let handler: ((next: MobileCompanionState) => void) | null = null
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    mobile: {
      ...base.mobile,
      getState: async () => structuredClone(state),
      onStateChanged: (next) => {
        handler = next
        return () => {
          handler = null
        }
      },
      enable: async (address) => {
        calls.enable.push(address)
        state.enabled = true
        state.running = true
        state.url = `https://${address}:42773`
      },
      disable: async () => {
        calls.disable += 1
        state.enabled = false
        state.running = false
        state.url = null
      },
      setDeviceAccess: async (id, access, rootTrusted) => {
        calls.setAccess.push({ id, access, rootTrusted })
        const device = state.devices.find((candidate) => candidate.id === id)
        if (device) device.access = access
      },
      revokeDevice: async (id) => {
        calls.revoke.push(id)
        state.devices = state.devices.filter((candidate) => candidate.id !== id)
      },
      respondPairing: async (decision, code, pairingId, rootTrusted) => {
        calls.pairing.push({ decision, code, pairingId, rootTrusted })
        state.pairing = null
      },
      revealCertificate: async () => {
        calls.revealed += 1
      },
      registerName: async (invite) => {
        calls.registerName.push(invite)
      },
      removeName: async () => {
        calls.removeName += 1
      },
      recheckNameDns: async () => {
        calls.recheckNameDns += 1
      },
    },
  }
  return {
    api,
    state,
    calls,
    push: (patch): void => {
      Object.assign(state, patch)
      handler?.(structuredClone(state))
    },
  }
}

describe('createMobileCompanionSection', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('loads the enabled state and available networks on refresh', async () => {
    const { api } = mockApi({ enabled: true, running: true, url: 'https://192.168.1.5:42773' })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()

    const toggle = section.root.querySelector<HTMLInputElement>(
      'input[name="mobileCompanionEnabled"]',
    )
    assert.ok(toggle)
    assert.equal(toggle.checked, true)
    const option = section.root.querySelector<HTMLOptionElement>(
      'select[name="mobileCompanionAddress"] option',
    )
    assert.equal(option?.value, '192.168.1.5')
    assert.match(section.root.textContent, /https:\/\/192\.168\.1\.5:42773/)
  })

  it('shows the pairing QR once the server reports one, and hides it otherwise', async () => {
    const { api, push } = mockApi({
      enabled: true,
      running: true,
      url: 'https://192.168.1.5:42773',
    })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()

    const qr = section.root.querySelector<HTMLElement>('#mobile-companion-qr')
    assert.ok(qr)
    assert.equal(qr.hidden, true)

    push({ qrSvg: '<svg></svg>' })
    assert.equal(qr.hidden, false)
    assert.equal(qr.querySelector('.mobile-companion-qr-image')?.innerHTML, '<svg></svg>')
    assert.equal(
      qr.querySelector('.mobile-companion-qr-url')?.textContent,
      'https://192.168.1.5:42773',
    )

    push({ qrSvg: null })
    assert.equal(qr.hidden, true)
  })

  it('enables Mobile Companion on the selected address', async () => {
    const { api, calls } = mockApi()
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()

    const select = section.root.querySelector<HTMLSelectElement>(
      'select[name="mobileCompanionAddress"]',
    )
    const toggle = section.root.querySelector<HTMLInputElement>(
      'input[name="mobileCompanionEnabled"]',
    )
    assert.ok(select)
    assert.ok(toggle)
    select.value = '192.168.1.5'
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(calls.enable, ['192.168.1.5'])
  })

  it('disables Mobile Companion', async () => {
    const { api, calls } = mockApi({ enabled: true, running: true, url: 'https://x:1' })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()

    const toggle = section.root.querySelector<HTMLInputElement>(
      'input[name="mobileCompanionEnabled"]',
    )
    assert.ok(toggle)
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(calls.disable, 1)
  })

  it('shows a live-pushed pairing request and only allows control once trust is confirmed', async () => {
    const { api, calls, push } = mockApi()
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()

    push({
      pairing: {
        id: '8abde2d0-8c97-4a99-9ea8-a7518309ee52',
        label: "Jonathan's iPhone",
        code: '123456',
        trustedName: false,
      },
    })

    assert.match(section.root.textContent, /123456/)
    assert.match(section.root.textContent, /Jonathan's iPhone/)

    const controlBtn = Array.from(section.root.querySelectorAll('button')).find(
      (button) => button.textContent === 'Allow control',
    )
    const trustInput = controlBtn
      ?.closest('.mobile-companion-pairing-banner')
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    assert.ok(controlBtn)
    assert.ok(trustInput)
    assert.equal(controlBtn.hasAttribute('disabled'), true)

    controlBtn.click()
    assert.deepEqual(calls.pairing, [])

    trustInput.checked = true
    trustInput.dispatchEvent(new Event('change'))
    assert.equal(controlBtn.hasAttribute('disabled'), false)
    controlBtn.click()
    assert.deepEqual(calls.pairing, [
      {
        decision: 'control',
        code: '123456',
        pairingId: '8abde2d0-8c97-4a99-9ea8-a7518309ee52',
        rootTrusted: true,
      },
    ])
  })

  it('requires fresh acknowledgement when a replacement repeats both label and code', async () => {
    const { api, calls, push } = mockApi({
      pairing: {
        id: '8abde2d0-8c97-4a99-9ea8-a7518309ee52',
        label: 'First phone',
        code: '123456',
        trustedName: false,
      },
    })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()
    const originalTrust = section.root.querySelector<HTMLInputElement>(
      '.mobile-companion-pairing-banner input',
    )
    assert.ok(originalTrust)
    originalTrust.checked = true
    originalTrust.dispatchEvent(new Event('change'))

    push({
      pairing: {
        id: '8abde2d0-8c97-4a99-9ea8-a7518309ee53',
        label: 'First phone',
        code: '123456',
        trustedName: false,
      },
    })
    const banner = section.root.querySelector('.mobile-companion-pairing-banner')
    assert.ok(banner)
    const trust = banner.querySelector<HTMLInputElement>('input')
    const control = Array.from(banner.querySelectorAll('button')).find(
      (button) => button.textContent === 'Allow control',
    )
    assert.ok(trust)
    assert.ok(control)
    assert.equal(trust.checked, false)
    assert.equal(control.disabled, true)
    trust.checked = true
    trust.dispatchEvent(new Event('change'))
    control.click()
    assert.deepEqual(calls.pairing, [
      {
        decision: 'control',
        code: '123456',
        pairingId: '8abde2d0-8c97-4a99-9ea8-a7518309ee53',
        rootTrusted: true,
      },
    ])
  })

  it('allows read-only pairing without requiring the trust checkbox', async () => {
    const { api, calls } = mockApi({
      pairing: {
        id: '8abde2d0-8c97-4a99-9ea8-a7518309ee52',
        label: 'My phone',
        code: '123456',
        trustedName: false,
      },
    })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()
    const read = Array.from(section.root.querySelectorAll('button')).find(
      (button) => button.textContent === 'Read only',
    )
    assert.ok(read)
    read.click()
    assert.deepEqual(calls.pairing, [
      {
        decision: 'read',
        code: '123456',
        pairingId: '8abde2d0-8c97-4a99-9ea8-a7518309ee52',
        rootTrusted: undefined,
      },
    ])
  })

  it('denies pairing without requiring the trust checkbox', async () => {
    const { api, calls, push } = mockApi()
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()

    push({
      pairing: {
        id: '8abde2d0-8c97-4a99-9ea8-a7518309ee52',
        label: 'Unknown phone',
        code: '000000',
        trustedName: false,
      },
    })
    const denyBtn = Array.from(section.root.querySelectorAll('button')).find(
      (button) => button.textContent === 'Deny',
    )
    assert.ok(denyBtn)
    denyBtn.click()
    assert.deepEqual(calls.pairing, [
      {
        decision: 'deny',
        code: '000000',
        pairingId: '8abde2d0-8c97-4a99-9ea8-a7518309ee52',
        rootTrusted: undefined,
      },
    ])
  })

  it('lists paired devices and revokes on request', async () => {
    const { api, calls } = mockApi({
      devices: [{ id: 'device-1', label: "Jonathan's iPhone", access: 'read', createdAt: 0 }],
    })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()

    assert.match(section.root.textContent, /Jonathan's iPhone/)
    assert.match(section.root.textContent, /Read only/)

    const revokeBtn = section.root.querySelector<HTMLButtonElement>(
      '.mobile-companion-device-revoke',
    )
    assert.ok(revokeBtn)
    revokeBtn.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(calls.revoke, ['device-1'])
  })

  it('requires trust confirmation before granting an existing device control', async () => {
    const { api, calls } = mockApi({
      devices: [{ id: 'device-1', label: "Jonathan's iPhone", access: 'read', createdAt: 0 }],
    })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()

    const toControlBtn = Array.from(section.root.querySelectorAll('button')).find(
      (button) => button.textContent === 'Allow control',
    )
    const trustInput =
      toControlBtn?.parentElement?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    assert.ok(toControlBtn)
    assert.ok(trustInput)

    toControlBtn.click()
    assert.deepEqual(calls.setAccess, [])

    trustInput.checked = true
    trustInput.dispatchEvent(new Event('change'))
    toControlBtn.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(calls.setAccess, [{ id: 'device-1', access: 'control', rootTrusted: true }])
  })

  it('grants control over the trusted name on the desktop approval alone', async () => {
    const { api, calls } = mockApi({
      pairing: {
        id: '8abde2d0-8c97-4a99-9ea8-a7518309ee52',
        label: 'Phone',
        code: '123456',
        trustedName: true,
      },
    })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()
    const banner = section.root.querySelector('.mobile-companion-pairing-banner')
    assert.ok(banner)
    assert.equal(banner.querySelector('input[type="checkbox"]'), null)
    assert.match(banner.textContent, /trusted name/)
    const controlBtn = Array.from(banner.querySelectorAll('button')).find(
      (button) => button.textContent === 'Allow control',
    )
    assert.ok(controlBtn)
    assert.equal(controlBtn.hasAttribute('disabled'), false)
    controlBtn.click()
    assert.deepEqual(calls.pairing, [
      {
        decision: 'control',
        code: '123456',
        pairingId: '8abde2d0-8c97-4a99-9ea8-a7518309ee52',
        rootTrusted: undefined,
      },
    ])
  })

  it('redeems a pasted invite and refuses an empty one', async () => {
    const { api, calls } = mockApi()
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()
    const input = section.root.querySelector<HTMLInputElement>(
      'input[name="mobileCompanionInvite"]',
    )
    const button = Array.from(section.root.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Get a name',
    )
    assert.ok(input && button)
    button.click()
    assert.equal(input.getAttribute('aria-invalid'), 'true')
    assert.deepEqual(calls.registerName, [])
    input.value = '  invite-abc  '
    input.dispatchEvent(new Event('input'))
    assert.equal(input.hasAttribute('aria-invalid'), false)
    button.click()
    assert.deepEqual(calls.registerName, ['invite-abc'])
  })

  it('keeps a half-typed invite across state pushes', async () => {
    const { api, push } = mockApi()
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()
    const input = section.root.querySelector<HTMLInputElement>(
      'input[name="mobileCompanionInvite"]',
    )
    assert.ok(input)
    input.value = 'inv'
    push({ publicName: { ...unregistered, busy: 'registering' } })
    assert.equal(input.value, 'inv')
    assert.equal(
      section.root.querySelector<HTMLInputElement>('input[name="mobileCompanionInvite"]'),
      input,
    )
    assert.match(section.root.textContent, /Getting a name…/)
  })

  it('shows the registered name, its certificate and a way to remove it', async () => {
    const { api, calls } = mockApi({ publicName: registered })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()
    const card = section.root.querySelector<HTMLElement>('.mobile-companion-name')
    assert.ok(card)
    assert.match(card.textContent, new RegExp(hostname.replaceAll('.', '\\.')))
    assert.match(card.textContent, /Certificate valid until/)
    const invite = card.querySelector<HTMLElement>('.mobile-companion-invite')
    assert.equal(invite?.hidden, true)
    const remove = Array.from(card.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove name',
    )
    assert.ok(remove)
    remove.click()
    assert.equal(calls.removeName, 1)
  })

  it('serves the trusted name first, with the LAN IP as the fallback', async () => {
    const { api } = mockApi({
      enabled: true,
      running: true,
      url: `https://${hostname}:42773`,
      qrSvg: '<svg data-qr="name"></svg>',
      localUrl: 'https://192.168.1.5:42773',
      localQrSvg: '<svg data-qr="local"></svg>',
      publicName: registered,
    })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()
    const nameQr = section.root.querySelector<HTMLElement>('#mobile-companion-qr')
    const localQr = section.root.querySelector<HTMLElement>('#mobile-companion-local-qr')
    assert.ok(nameQr && localQr)
    assert.equal(nameQr.hidden, false)
    assert.equal(localQr.hidden, true)
    assert.match(section.root.textContent, /https:\/\/192\.168\.1\.5:42773/)
    const swap = Array.from(section.root.querySelectorAll('button')).find(
      (button) => button.textContent === 'Show the local-address QR',
    )
    assert.ok(swap)
    swap.click()
    assert.equal(
      section.root.querySelector<HTMLElement>('#mobile-companion-local-qr')?.hidden,
      false,
    )
  })

  it('explains DNS-rebind protection and leads with the local address when the name does not resolve', async () => {
    const { api, calls } = mockApi({
      enabled: true,
      running: true,
      url: `https://${hostname}:42773`,
      qrSvg: '<svg data-qr="name"></svg>',
      localUrl: 'https://192.168.1.5:42773',
      localQrSvg: '<svg data-qr="local"></svg>',
      publicName: { ...registered, dns: 'unresolved' },
    })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()
    assert.match(section.root.textContent, /DNS-rebind protection/)
    assert.equal(section.root.querySelector<HTMLElement>('#mobile-companion-qr')?.hidden, true)
    assert.equal(
      section.root.querySelector<HTMLElement>('#mobile-companion-local-qr')?.hidden,
      false,
    )
    const recheck = Array.from(section.root.querySelectorAll('button')).find(
      (button) => button.textContent === 'Check again',
    )
    assert.ok(recheck)
    recheck.click()
    assert.equal(calls.recheckNameDns, 1)
  })

  it('flags a virtual interface and warns when the trusted name points at one', async () => {
    const { api } = mockApi({
      enabled: true,
      running: true,
      url: `https://${hostname}:42773`,
      localUrl: 'https://192.168.64.1:42773',
      address: '192.168.64.1',
      addresses: [
        { address: '192.168.0.191', interfaceName: 'en0', virtual: false },
        { address: '192.168.64.1', interfaceName: 'bridge100', virtual: true },
      ],
      publicName: registered,
    })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()
    const select = section.root.querySelector<HTMLSelectElement>(
      'select[name="mobileCompanionAddress"]',
    )
    assert.ok(select)
    assert.equal(select.value, '192.168.64.1')
    assert.match(select.selectedOptions[0]?.textContent ?? '', /bridge100 .*\(virtual or VPN\)/)
    assert.match(section.root.textContent, /bridge100 is a virtual-machine or VPN network/)
    const card = section.root.querySelector<HTMLElement>('.mobile-companion-name')
    assert.match(card?.textContent ?? '', /points at 192\.168\.64\.1 on bridge100/)
  })

  it('defaults to the first listed interface and shows no warning for Wi-Fi', async () => {
    const { api } = mockApi({
      addresses: [
        { address: '192.168.0.191', interfaceName: 'en0', virtual: false },
        { address: '192.168.64.1', interfaceName: 'bridge100', virtual: true },
      ],
    })
    const section = createMobileCompanionSection(api)
    document.body.append(section.root)
    await section.refresh()
    const select = section.root.querySelector<HTMLSelectElement>(
      'select[name="mobileCompanionAddress"]',
    )
    assert.equal(select?.value, '192.168.0.191')
    assert.doesNotMatch(section.root.textContent, /virtual-machine or VPN network/)
  })
})
