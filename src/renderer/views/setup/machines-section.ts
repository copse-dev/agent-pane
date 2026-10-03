import type { ApiClient } from '../../../preload/api.d.ts'
import type { MachinesState } from '@shared/machines.ts'
import { el, clear } from '../../dom/helpers.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'

export function createMachinesSection(api: Pick<ApiClient, 'machines' | 'classifiers'>): {
  root: HTMLDivElement
  refresh: () => Promise<void>
} {
  const status = el('div', { class: 'machine-status', role: 'status' })
  const sharingFeedback = el('div', { class: 'machine-sharing-feedback', role: 'status' })
  const list = el('div', { class: 'machine-list' })
  const invitationInput = el('textarea', {
    name: 'machineInvitation',
    rows: '3',
    placeholder: 'copse-machine1-…',
    spellcheck: 'false',
  })
  const pair = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary machine-pair' },
    'Connect machine',
  )
  const enabled = el('input', { type: 'checkbox', name: 'machineSharingEnabled' })
  const address = el('select', { name: 'machineSharingAddress' })
  const port = el('input', {
    type: 'number',
    name: 'machineSharingPort',
    min: '0',
    max: '65535',
    value: '4319',
  })
  const models = el('div', { class: 'machine-share-models' })
  const apply = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary machine-sharing-save' },
    'Apply sharing settings',
  )
  const invite = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-secondary machine-invite', disabled: true },
    'Create pairing invitation',
  )
  const code = el('textarea', {
    name: 'machineSharingInvitation',
    rows: '3',
    readonly: true,
    hidden: true,
    'aria-label': 'Pairing invitation for this machine',
  })
  const hostingStatus = el('p', { class: 'field-hint machine-sharing-status' })
  const clients = el('div', { class: 'machine-client-list' })
  const secure = el('p', { class: 'field-hint machine-secure-storage' })
  const featureHint = el(
    'p',
    { class: 'field-hint machine-feature-hint' },
    'Remote System One models are off. Enable them in Settings → Experimental to connect Copse computers. SSH settings are available below.',
  )
  const sharingControls = el(
    'div',
    { class: 'machine-sharing-controls', hidden: true },
    el('label', { class: 'checkbox-label' }, enabled, ' Share models on my network'),
    el('label', {}, 'Network', address),
    el('label', {}, 'Port', port),
    models,
    el('div', { class: 'provider-actions' }, apply, invite),
    code,
    el(
      'p',
      { class: 'field-hint' },
      'Invitations expire after ten minutes and connect one client. Create a new invitation for each client.',
    ),
  )
  const sharing = el(
    'fieldset',
    { class: 'machine-sharing-section', hidden: true },
    el('legend', {}, 'Share models from this machine'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Allow paired Copse clients to call the local System One connections you select below. Copse must stay open and this computer must stay awake.',
    ),
    sharingControls,
    hostingStatus,
    clients,
    sharingFeedback,
  )
  const pairControls = el(
    'div',
    { class: 'machine-pair-controls', hidden: true },
    el('label', {}, 'Pairing invitation', invitationInput),
    el('div', { class: 'provider-actions' }, pair),
    secure,
  )
  const paired = el(
    'fieldset',
    { hidden: true },
    el('legend', {}, 'Paired Copse machines'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Use System One models on another computer on the same network. Open Copse there, share a local model, and paste its invitation here. SSH is not required.',
    ),
    list,
    pairControls,
    status,
  )
  const root = el('div', { class: 'machines-settings' }, featureHint, paired, sharing)
  let state: MachinesState | undefined
  let initialized = false
  let busy = false
  let refreshing = false
  let rendered = ''
  let sharingRendered = ''
  const selectedModels = new Map<string, string>()
  function show(next: MachinesState, resetSharing = false): void {
    state = next
    featureHint.hidden = next.featureEnabled
    pairControls.hidden = !next.featureEnabled
    sharingControls.hidden = !next.featureEnabled
    paired.hidden = !next.featureEnabled && !next.machines.length
    sharing.hidden = !next.featureEnabled && !next.clients.length
    if (!next.featureEnabled) {
      code.hidden = true
      code.value = ''
    }
    pair.disabled = busy || !next.featureEnabled || !next.secureStorage
    apply.disabled = busy || !next.featureEnabled || (!next.secureStorage && enabled.checked)
    invite.disabled = busy || !next.featureEnabled || !next.sharing.listening
    secure.textContent = next.secureStorage
      ? 'Pairing credentials are encrypted on this computer.'
      : 'Unlock the system keyring to pair machines or enable sharing.'
    hostingStatus.textContent = !next.featureEnabled
      ? 'Remote System One models are off.'
      : next.sharing.listening
        ? `Sharing on ${next.sharing.address}:${String(next.sharing.port)}`
        : (next.sharing.error ?? 'Model sharing is off.')
    if (!initialized || resetSharing) {
      enabled.checked = next.sharing.enabled
      clear(address)
      for (const item of next.addresses)
        address.append(el('option', { value: item.address }, item.label))
      if (!next.addresses.some((item) => item.address === next.sharing.address))
        address.append(
          el('option', { value: next.sharing.address }, `${next.sharing.address} (unavailable)`),
        )
      address.value =
        initialized || next.sharing.enabled
          ? next.sharing.address
          : (next.addresses.find((entry) => entry.address !== '127.0.0.1')?.address ??
            next.sharing.address)
      port.value = String(next.sharing.port)
      initialized = true
    }
    const modelKey = JSON.stringify(next.shareableModels)
    if (sharingRendered !== modelKey || resetSharing) {
      sharingRendered = modelKey
      clear(models)
      if (!next.shareableModels.length)
        models.append(
          el(
            'p',
            { class: 'field-hint' },
            'Add a local System One connection in Settings → Classifiers first.',
          ),
        )
      for (const model of next.shareableModels) {
        const input = el('input', {
          type: 'checkbox',
          name: 'machineSharedProfile',
          value: model.id,
        })
        input.checked = next.sharing.profileIds.includes(model.id)
        models.append(
          el('label', { class: 'checkbox-label' }, input, ` ${model.label} · ${model.model}`),
        )
      }
    }
    const key = JSON.stringify([next.featureEnabled, next.machines, next.clients])
    if (rendered === key) return
    rendered = key
    clear(list)
    if (!next.machines.length)
      list.append(el('p', { class: 'field-hint' }, 'No paired machines yet.'))
    for (const machine of next.machines) {
      const choose = el('select', {
        'aria-label': `Model on ${machine.name}`,
        disabled: machine.status !== 'connected',
      })
      for (const model of machine.models)
        choose.append(el('option', { value: model.id }, `${model.label} · ${model.model}`))
      choose.value = selectedModels.get(machine.id) ?? machine.models[0]?.id ?? ''
      choose.addEventListener('change', () => selectedModels.set(machine.id, choose.value))
      const use = el(
        'button',
        {
          type: 'button',
          class: 'ui-btn ui-btn-secondary machine-use-model',
          hidden: !next.featureEnabled,
          disabled: machine.status !== 'connected' || !machine.models.length,
        },
        'Use this model',
      )
      const remove = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-secondary machine-remove' },
        'Disconnect',
      )
      const row = el(
        'div',
        { class: 'machine-row', 'data-machine-id': machine.id },
        el('h4', {}, machine.name),
        el(
          'p',
          { class: 'field-hint machine-connection-status' },
          `${machine.address} · ${machine.detail}`,
        ),
        el('label', { hidden: !next.featureEnabled }, 'Shared model', choose),
        el('div', { class: 'provider-actions' }, use, remove),
      )
      use.addEventListener('click', () => {
        void action(async () => {
          const model = machine.models.find((entry) => entry.id === choose.value)
          if (!model) throw new Error('Choose a shared model first.')
          const configured = await api.classifiers.list()
          const existing = configured.find(
            ({ profile }) =>
              profile.connection.type === 'machine' &&
              profile.connection.machineId === machine.id &&
              profile.connection.profileId === model.id,
          )
          await api.classifiers.save({
            id: existing?.profile.id ?? `machine-${crypto.randomUUID()}`,
            label: `${machine.name} · ${model.label}`.slice(0, 120),
            model: model.model,
            timeoutMs: model.timeoutMs,
            connection: { type: 'machine', machineId: machine.id, profileId: model.id },
          })
          setInlineStatus(
            status,
            'ok',
            'Model connection saved. Open Classifiers to test it or select it for safety screening.',
          )
        })
      })
      remove.addEventListener('click', () => {
        void action(async () => {
          show(await api.machines.remove(machine.id))
          setInlineStatus(
            status,
            'ok',
            'Machine disconnected. Its saved model connections will report unavailable until you pair it again.',
          )
        })
      })
      list.append(row)
    }
    clear(clients)
    for (const client of next.clients) {
      const revoke = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-secondary machine-revoke' },
        'Revoke access',
      )
      revoke.addEventListener('click', () => {
        void action(async () => {
          show(await api.machines.revoke(client.id))
          code.hidden = true
          code.value = ''
          setInlineStatus(sharingFeedback, 'ok', `Access revoked for ${client.name}.`)
        }, sharingFeedback)
      })
      clients.append(
        el('div', { class: 'machine-client-row' }, el('span', {}, client.name), revoke),
      )
    }
  }
  async function action(run: () => Promise<void>, feedback = status): Promise<void> {
    if (busy) return
    busy = true
    for (const control of root.querySelectorAll('button')) control.disabled = true
    try {
      await run()
    } catch (error) {
      setInlineStatus(
        feedback,
        'error',
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
          : 'Machine request failed.',
      )
    } finally {
      busy = false
      rendered = ''
      if (state) show(state)
    }
  }
  pair.addEventListener('click', () => {
    void action(async () => {
      show(await api.machines.pair(invitationInput.value.trim()))
      invitationInput.value = ''
      setInlineStatus(status, 'ok', 'Machine connected. Choose a shared model below its name.')
    })
  })
  enabled.addEventListener('change', () => {
    apply.disabled = busy || !state?.featureEnabled || (!state.secureStorage && enabled.checked)
  })
  apply.addEventListener('click', () => {
    void action(async () => {
      const profileIds = Array.from(models.querySelectorAll<HTMLInputElement>('input:checked')).map(
        (input) => input.value,
      )
      show(
        await api.machines.share({
          enabled: enabled.checked,
          address: address.value,
          port: Number(port.value),
          profileIds,
        }),
        true,
      )
      code.hidden = true
      code.value = ''
      setInlineStatus(
        sharingFeedback,
        'ok',
        enabled.checked ? 'Sharing enabled for the selected models.' : 'Sharing stopped.',
      )
    }, sharingFeedback)
  })
  invite.addEventListener('click', () => {
    void action(async () => {
      code.value = await api.machines.invitation()
      code.hidden = false
      code.select()
      setInlineStatus(
        sharingFeedback,
        'ok',
        'Copy this invitation to the other computer. It expires in ten minutes.',
      )
    }, sharingFeedback)
  })
  async function refresh(): Promise<void> {
    if (refreshing || busy) return
    refreshing = true
    try {
      show(await api.machines.state())
    } catch (error) {
      setInlineStatus(
        status,
        'error',
        error instanceof Error ? error.message : 'Could not load machines.',
      )
    } finally {
      refreshing = false
    }
  }
  return { root, refresh }
}
