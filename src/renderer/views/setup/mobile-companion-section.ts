import type { ApiClient } from '../../../preload/api.d.ts'
import type {
  MobileCompanionDevice,
  MobileCompanionState,
} from '../../../shared/types/mobile-companion.ts'
import { el, clear } from '../../dom/helpers.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'

export interface MobileCompanionSection {
  root: HTMLFieldSetElement
  refresh: () => Promise<void>
}

/**
 * Everything about Mobile Companion — enabling, the network choice, pairing
 * approval, and per-phone access — lives here. Control grants also require a
 * native desktop confirmation of the phone’s certificate trust.
 */
export function createMobileCompanionSection(api: ApiClient): MobileCompanionSection {
  const status = el('span', { class: 'mobile-companion-status' })
  const enabledInput = el('input', { type: 'checkbox', name: 'mobileCompanionEnabled' })
  const addressSelect = el('select', { name: 'mobileCompanionAddress' })
  const addressHint = el('p', { class: 'field-hint' })
  const connectionInfo = el('div', { class: 'mobile-companion-connection' })
  const qrImage = el('div', { class: 'mobile-companion-qr-image', 'aria-hidden': 'true' })
  const qrUrl = el('code', { class: 'mobile-companion-qr-url' })
  const qrHost = el(
    'div',
    { id: 'mobile-companion-qr', class: 'mobile-companion-qr', hidden: true },
    qrImage,
    el(
      'div',
      { class: 'mobile-companion-qr-text' },
      el('p', { class: 'field-hint' }, "Scan with your phone's camera to open Copse."),
      qrUrl,
    ),
  )
  const pairingHost = el('div', { class: 'mobile-companion-pairing' })
  const deviceList = el('div', { class: 'mobile-companion-device-list' })

  let lastPairingKey: string | null = null
  let lastDevicesKey: string | null = null

  function renderAddresses(state: MobileCompanionState): void {
    const previous = addressSelect.value
    clear(addressSelect)
    for (const candidate of state.addresses) {
      addressSelect.append(
        el(
          'option',
          { value: candidate.address },
          `${candidate.interfaceName} — ${candidate.address}`,
        ),
      )
    }
    if (state.addresses.some((candidate) => candidate.address === previous))
      addressSelect.value = previous
    const disabled = state.addresses.length === 0 || state.enabled
    if (disabled) addressSelect.setAttribute('disabled', '')
    else addressSelect.removeAttribute('disabled')
    addressHint.textContent =
      state.addresses.length === 0
        ? 'Connect this Mac to a private Wi-Fi or wired network first.'
        : 'Pick the interface your phone is on — usually Wi-Fi. Turn Mobile Companion off to change it.'
  }

  function renderConnection(state: MobileCompanionState): void {
    clear(connectionInfo)
    if (!state.enabled) {
      qrHost.hidden = true
      return
    }
    if (!state.running || !state.url) {
      qrHost.hidden = true
      connectionInfo.append(
        el(
          'p',
          { class: 'field-hint' },
          'Enabled, but its local server is not running yet. Copse retries automatically while it is open.',
        ),
      )
      return
    }
    connectionInfo.append(
      el('p', {}, 'Open ', el('strong', {}, state.url), ' on your phone.'),
      el(
        'p',
        { class: 'field-hint' },
        'Transfer the trust certificate directly to your phone and install it there for a verified connection — it can only vouch for private-network addresses, never a website. Remove it from the phone’s certificate settings when you no longer need it.',
      ),
    )
    if (state.rootCertificatePath) {
      const revealBtn = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-secondary' },
        'Reveal certificate…',
      )
      revealBtn.addEventListener('click', () => {
        void api.mobile.revealCertificate()
      })
      connectionInfo.append(revealBtn)
    }
    // The server generates this SVG (via `qrcode`) from the same URL already
    // shown as text above, so scanning it adds no new trust claim — it only
    // saves typing the address into the phone's browser.
    connectionInfo.append(qrHost)
    if (state.qrSvg) {
      qrImage.innerHTML = state.qrSvg
      qrUrl.textContent = state.url
      qrHost.hidden = false
    } else {
      qrHost.hidden = true
    }
  }

  function pairingKey(state: MobileCompanionState): string | null {
    return state.pairing ? `${state.pairing.label}:${state.pairing.code}` : null
  }

  function renderPairing(state: MobileCompanionState): void {
    const key = pairingKey(state)
    if (key === lastPairingKey) return
    lastPairingKey = key
    clear(pairingHost)
    const pairing = state.pairing
    if (!pairing) return
    const trustInput = el('input', { type: 'checkbox' })
    const controlBtn = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-primary', disabled: true },
      'Allow control',
    )
    const readBtn = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Read only')
    const denyBtn = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Deny')
    trustInput.addEventListener('change', () => {
      controlBtn.toggleAttribute('disabled', !trustInput.checked)
    })
    readBtn.addEventListener('click', () => {
      void api.mobile.respondPairing('read')
    })
    controlBtn.addEventListener('click', () => {
      if (trustInput.checked) void api.mobile.respondPairing('control')
    })
    denyBtn.addEventListener('click', () => {
      void api.mobile.respondPairing('deny')
    })
    pairingHost.append(
      el(
        'div',
        { class: 'mobile-companion-pairing-banner' },
        el('p', {}, 'Does this code appear on ', el('strong', {}, pairing.label), '?'),
        el('p', { class: 'mobile-companion-pairing-code' }, pairing.code),
        el(
          'p',
          { class: 'field-hint' },
          'Read only shares thread names, saved messages, and activity. Allow control also lets this phone send messages, start chats, stop runs, answer questions, and approve individual requests. Only pair a phone you hold. Allow control opens a desktop confirmation of certificate trust.',
        ),
        el(
          'label',
          { class: 'checkbox-label' },
          trustInput,
          ' The Copse Local Root is installed and trusted on this phone',
        ),
        el('div', { class: 'settings-action-row' }, denyBtn, readBtn, controlBtn),
      ),
    )
  }

  function deviceRow(device: MobileCompanionDevice): HTMLDivElement {
    const row = el('div', { class: 'mobile-companion-device-row' })
    const summary = el(
      'div',
      { class: 'mobile-companion-device-summary' },
      el('strong', {}, device.label),
      ` — ${device.access === 'control' ? 'Chat and run control' : 'Read only'}`,
    )
    const actions = el('div', { class: 'mobile-companion-device-actions' })
    if (device.access === 'control') {
      const toReadBtn = el('button', { type: 'button' }, 'Make read only')
      toReadBtn.addEventListener('click', () => {
        void api.mobile.setDeviceAccess(device.id, 'read')
      })
      actions.append(toReadBtn)
    } else {
      const trustInput = el('input', { type: 'checkbox' })
      const toControlBtn = el('button', { type: 'button', disabled: true }, 'Allow control')
      trustInput.addEventListener('change', () => {
        toControlBtn.toggleAttribute('disabled', !trustInput.checked)
      })
      toControlBtn.addEventListener('click', () => {
        if (trustInput.checked) void api.mobile.setDeviceAccess(device.id, 'control')
      })
      actions.append(
        el(
          'label',
          { class: 'checkbox-label mobile-companion-trust-label' },
          trustInput,
          ' Trusted',
        ),
        toControlBtn,
      )
    }
    const revokeBtn = el(
      'button',
      { type: 'button', class: 'mobile-companion-device-revoke' },
      'Revoke',
    )
    revokeBtn.addEventListener('click', () => {
      void api.mobile.revokeDevice(device.id)
    })
    actions.append(revokeBtn)
    row.append(summary, actions)
    return row
  }

  function renderDevices(state: MobileCompanionState): void {
    const key = JSON.stringify(state.devices)
    if (key === lastDevicesKey) return
    lastDevicesKey = key
    clear(deviceList)
    if (state.devices.length === 0) {
      deviceList.append(el('p', { class: 'field-hint' }, 'No phones are paired.'))
      return
    }
    deviceList.append(
      el(
        'p',
        { class: 'field-hint' },
        'Revoking access takes effect immediately. If you installed the Copse Local Root on that phone, remove it in the phone’s certificate settings too.',
      ),
    )
    for (const device of state.devices) deviceList.append(deviceRow(device))
  }

  function applyState(state: MobileCompanionState): void {
    enabledInput.checked = state.enabled
    renderAddresses(state)
    renderConnection(state)
    renderPairing(state)
    renderDevices(state)
    if (state.lastError) setInlineStatus(status, 'error', state.lastError)
    else status.replaceChildren()
  }

  enabledInput.addEventListener('change', () => {
    void (async (): Promise<void> => {
      if (enabledInput.checked) {
        const address = addressSelect.value
        if (!address) {
          enabledInput.checked = false
          return
        }
        await api.mobile.enable(address)
      } else {
        await api.mobile.disable()
      }
      await refresh()
    })()
  })

  async function refresh(): Promise<void> {
    const state = await api.mobile.getState()
    applyState(state)
  }

  api.mobile.onStateChanged((state: MobileCompanionState) => {
    applyState(state)
  })

  const root = el(
    'fieldset',
    {},
    el('legend', {}, 'Mobile Companion'),
    el(
      'p',
      { class: 'field-hint' },
      'Open your Copse threads from a phone on the same local network. Choose the network interface your phone uses, pair phones, or turn sharing off. Copse must stay open and this computer must stay awake.',
    ),
    el('label', { class: 'checkbox-label' }, enabledInput, ' Enable Mobile Companion'),
    el('label', {}, 'Network ', addressSelect),
    addressHint,
    connectionInfo,
    pairingHost,
    deviceList,
    status,
  )

  return { root, refresh }
}
