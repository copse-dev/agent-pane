import type { ApiClient } from '../../../preload/api.d.ts'
import type {
  MobileCompanionDevice,
  MobileCompanionPublicName,
  MobileCompanionState,
} from '../../../shared/types/mobile-companion.ts'
import { el, clear } from '../../dom/helpers.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'
import { ipcErrorMessage } from '../../ipc-error-message.ts'

export interface MobileCompanionSection {
  root: HTMLFieldSetElement
  refresh: () => Promise<void>
}

/**
 * Everything about Mobile Companion — enabling, the network choice, the
 * trusted name, pairing approval, and per-phone access — lives here. Control
 * over the LAN IP also needs the desktop's confirmation that the phone trusts
 * the local root; over the trusted name, the browser verifies the certificate
 * itself and the desktop approval is enough.
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
  const localQrImage = el('div', { class: 'mobile-companion-qr-image', 'aria-hidden': 'true' })
  const localQrUrl = el('code', { class: 'mobile-companion-qr-url' })
  const localQrHost = el(
    'div',
    { id: 'mobile-companion-local-qr', class: 'mobile-companion-qr', hidden: true },
    localQrImage,
    el(
      'div',
      { class: 'mobile-companion-qr-text' },
      el('p', { class: 'field-hint' }, 'The local address works without DNS.'),
      localQrUrl,
    ),
  )
  const pairingHost = el('div', { class: 'mobile-companion-pairing' })
  const deviceList = el('div', { class: 'mobile-companion-device-list' })

  // The trusted-name card is built once and updated in place, so a state push
  // never clears an invite the user is typing.
  const inviteInput = el('input', {
    type: 'text',
    name: 'mobileCompanionInvite',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: '64',
    placeholder: 'Invite code',
    'aria-label': 'Invite code',
  })
  const registerBtn = el('button', { type: 'button', class: 'ui-btn ui-btn-primary' }, 'Get a name')
  const inviteRow = el('div', { class: 'mobile-companion-invite' }, inviteInput, registerBtn)
  const nameIntro = el(
    'p',
    { class: 'field-hint' },
    'Get a name like lan.…u.copse.me with a publicly trusted certificate, so a phone connects with nothing to install. The Copse names service only sees certificate requests and this Mac’s private network address; the key that controls the name stays in this Mac’s keychain.',
  )
  const nameSummary = el('div', { class: 'mobile-companion-name-summary' })
  const dnsNote = el('div', { class: 'mobile-companion-name-dns' })
  const recheckBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary ui-btn-compact' },
    'Check again',
  )
  const removeNameBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary' },
    'Remove name',
  )
  const nameStatus = el('span', { class: 'mobile-companion-name-status' })
  const nameCard = el(
    'fieldset',
    { class: 'mobile-companion-name' },
    el('legend', {}, 'Trusted address'),
    nameIntro,
    inviteRow,
    nameSummary,
    dnsNote,
    el('div', { class: 'settings-action-row' }, removeNameBtn),
    nameStatus,
  )

  let lastPairingKey: string | null = null
  let lastDevicesKey: string | null = null
  let lastState: MobileCompanionState | null = null
  /** Which QR the user chose; `null` follows DNS (the local one when the name does not resolve). */
  let qrChoice: 'name' | 'local' | null = null

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
    const trustedName = state.localUrl !== null
    connectionInfo.append(el('p', {}, 'Open ', el('strong', {}, state.url), ' on your phone.'))
    connectionInfo.append(
      trustedName && state.localUrl
        ? el(
            'p',
            { class: 'field-hint' },
            'Its certificate is publicly trusted, so there is nothing to install. If this network’s DNS cannot answer for the name, open ',
            el('strong', {}, state.localUrl),
            ' instead; that address needs the Copse Local Root on the phone, which can only vouch for private-network addresses, never a website.',
          )
        : el(
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
    connectionInfo.append(qrHost, localQrHost)
    const dnsBlocked = state.publicName.dns === 'unresolved' || state.publicName.dns === 'mismatch'
    const showLocal =
      state.localUrl !== null && (qrChoice === 'local' || (qrChoice === null && dnsBlocked))
    if (state.qrSvg && !showLocal) {
      qrImage.innerHTML = state.qrSvg
      qrUrl.textContent = state.url
      qrHost.hidden = false
    } else {
      qrHost.hidden = true
    }
    if (state.localQrSvg && state.localUrl && showLocal) {
      localQrImage.innerHTML = state.localQrSvg
      localQrUrl.textContent = state.localUrl
      localQrHost.hidden = false
    } else {
      localQrHost.hidden = true
    }
    if (state.localUrl) {
      const swapBtn = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-secondary ui-btn-compact' },
        showLocal ? 'Show the trusted-name QR' : 'Show the local-address QR',
      )
      swapBtn.addEventListener('click', () => {
        qrChoice = showLocal ? 'name' : 'local'
        if (lastState) renderConnection(lastState)
      })
      connectionInfo.append(el('div', { class: 'settings-action-row' }, swapBtn))
    }
  }

  function renderPublicName(state: MobileCompanionState): void {
    const name: MobileCompanionPublicName = state.publicName
    const registered = name.state !== 'unregistered'
    inviteRow.hidden = registered
    nameIntro.hidden = registered
    registerBtn.toggleAttribute('disabled', name.busy !== null)
    registerBtn.textContent = name.busy === 'registering' ? 'Getting a name…' : 'Get a name'
    removeNameBtn.parentElement?.toggleAttribute('hidden', !registered)
    removeNameBtn.toggleAttribute('disabled', name.busy !== null)
    removeNameBtn.textContent = name.busy === 'removing' ? 'Removing…' : 'Remove name'
    clear(nameSummary)
    clear(dnsNote)
    if (registered && name.hostname) {
      nameSummary.append(el('p', {}, el('strong', {}, name.hostname)))
      const certificate = name.certificate
      nameSummary.append(
        el(
          'p',
          { class: 'field-hint' },
          certificate && certificate.notAfter > Date.now()
            ? `Certificate valid until ${formatTime(certificate.notAfter)}${certificate.renewAt ? ` · renews from ${formatTime(certificate.renewAt)}` : ''}. Copse renews it while open.`
            : 'Waiting for a certificate. Copse keeps trying while it is open.',
        ),
      )
      if (name.state === 'dormant')
        nameSummary.append(
          el(
            'p',
            { class: 'field-hint mobile-companion-name-warning' },
            'This name went dormant after 30 days without a renewal and does not resolve. Copse renews it again while open.',
          ),
        )
      if (name.state === 'retired')
        nameSummary.append(
          el(
            'p',
            { class: 'field-hint mobile-companion-name-warning' },
            'The names service retired this name. Remove it, then register again with a new invite.',
          ),
        )
      if (state.running) renderDns(name.hostname, name.dns)
    }
    if (name.lastError) setInlineStatus(nameStatus, 'error', name.lastError)
    else nameStatus.replaceChildren()
  }

  function renderDns(hostname: string, dns: MobileCompanionPublicName['dns']): void {
    if (dns === 'ok' || dns === 'unknown') return
    if (dns === 'checking') {
      dnsNote.append(el('p', { class: 'field-hint' }, `Checking that ${hostname} resolves here…`))
      return
    }
    dnsNote.append(
      el(
        'p',
        { class: 'field-hint mobile-companion-name-warning' },
        dns === 'unresolved'
          ? `This network’s DNS does not answer for ${hostname}. Many routers drop public names that point at private addresses (DNS-rebind protection in dnsmasq, Pi-hole or OpenWrt), and a phone here will not reach the name either. Allow u.copse.me in the router’s rebind settings, or use the local address.`
          : `This network’s DNS answers ${hostname} with a different address. Right after a network change that clears within a minute; if it stays, use the local address.`,
      ),
      el('div', { class: 'settings-action-row' }, recheckBtn),
    )
  }

  function pairingKey(state: MobileCompanionState): string | null {
    return state.pairing?.id ?? null
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
      { type: 'button', class: 'ui-btn ui-btn-primary', disabled: !pairing.trustedName },
      'Allow control',
    )
    const readBtn = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Read only')
    const denyBtn = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, 'Deny')
    trustInput.addEventListener('change', () => {
      controlBtn.toggleAttribute('disabled', !trustInput.checked)
    })
    readBtn.addEventListener('click', () => {
      void api.mobile.respondPairing('read', pairing.code, pairing.id)
    })
    controlBtn.addEventListener('click', () => {
      if (pairing.trustedName) void api.mobile.respondPairing('control', pairing.code, pairing.id)
      else if (trustInput.checked)
        void api.mobile.respondPairing('control', pairing.code, pairing.id, trustInput.checked)
    })
    denyBtn.addEventListener('click', () => {
      void api.mobile.respondPairing('deny', pairing.code, pairing.id)
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
          'Read only shares thread names, saved messages, and activity. Allow control also lets this phone send messages, start chats, stop runs, answer questions, and approve individual requests. Only pair a phone you hold.',
          pairing.trustedName
            ? ' This phone connected over this Mac’s trusted name, and its browser verified the certificate.'
            : ' Confirm below that the Copse Local Root is installed and trusted on this phone before allowing control.',
        ),
        ...(pairing.trustedName
          ? []
          : [
              el(
                'label',
                { class: 'checkbox-label' },
                trustInput,
                ' The Copse Local Root is installed and trusted on this phone',
              ),
            ]),
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
        if (trustInput.checked)
          void api.mobile.setDeviceAccess(device.id, 'control', trustInput.checked)
      })
      actions.append(
        el(
          'label',
          { class: 'checkbox-label mobile-companion-trust-label' },
          trustInput,
          ' The Copse Local Root is installed and trusted on this phone',
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
    lastState = state
    enabledInput.checked = state.enabled
    renderAddresses(state)
    renderConnection(state)
    renderPublicName(state)
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

  registerBtn.addEventListener('click', () => {
    const invite = inviteInput.value.trim()
    if (!invite) {
      inviteInput.setAttribute('aria-invalid', 'true')
      inviteInput.focus()
      return
    }
    inviteInput.removeAttribute('aria-invalid')
    void api.mobile
      .registerName(invite)
      .then(() => {
        if (lastState?.publicName.state !== 'unregistered') inviteInput.value = ''
      })
      .catch((error: unknown) => {
        setInlineStatus(nameStatus, 'error', ipcErrorMessage(error, 'Could not get a name.'))
      })
  })
  inviteInput.addEventListener('input', () => {
    inviteInput.removeAttribute('aria-invalid')
  })
  removeNameBtn.addEventListener('click', () => {
    void api.mobile.removeName().catch((error: unknown) => {
      setInlineStatus(nameStatus, 'error', ipcErrorMessage(error, 'Could not remove the name.'))
    })
  })
  recheckBtn.addEventListener('click', () => {
    void api.mobile.recheckNameDns()
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
    { class: 'mobile-companion' },
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
    nameCard,
    pairingHost,
    deviceList,
    status,
  )

  return { root, refresh }
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
