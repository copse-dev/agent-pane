import '../../../../tests/setup-dom.ts'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../../preload/api.d.ts'
import type {
  MobileCompanionAccess,
  MobileCompanionState,
} from '../../../shared/types/mobile-companion.ts'
import { createMobileCompanionSection } from './mobile-companion-section.ts'
import { createFakeApi } from '../../fake-api.test-support.ts'

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
  }
  push: (patch: Partial<MobileCompanionState>) => void
} {
  const state: MobileCompanionState = {
    enabled: false,
    running: false,
    url: null,
    qrSvg: null,
    rootCertificatePath: null,
    addresses: [{ address: '192.168.1.5', interfaceName: 'en0' }],
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
      pairing: { id: '8abde2d0-8c97-4a99-9ea8-a7518309ee52', label: 'First phone', code: '123456' },
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
      pairing: { id: '8abde2d0-8c97-4a99-9ea8-a7518309ee53', label: 'First phone', code: '123456' },
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
      pairing: { id: '8abde2d0-8c97-4a99-9ea8-a7518309ee52', label: 'My phone', code: '123456' },
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
})
