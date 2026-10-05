import { errorMessage } from '@shared/errors.ts'
import type {
  LicenseFileKind,
  ThirdPartyComponent,
  ThirdPartyLicenseReport,
} from '@shared/third-party-licenses.mts'
import { chosenUpdateChannel, isReleaseChannel } from '@shared/update-channel-choice.ts'
import { getReleaseChannel, type ReleaseChannel } from '@shared/release-channel.mts'
import type { ApiClient } from '../../../preload/api.d.ts'
import { el } from '../../dom/helpers.ts'
import { setInlineStatus } from '../../dom/inline-status.ts'
import { uiActions } from '../../ui/index.ts'

export interface AboutSection {
  root: HTMLElement
  /** Load the version and licence report; cheap after the first call. */
  refresh: () => Promise<void>
}

const SHIPPED_AS_LABEL: Readonly<Record<ThirdPartyComponent['shippedAs'][number], string>> = {
  bundled: 'compiled into Copse',
  copied: 'files copied into Copse',
  node_modules: 'packaged as a module',
  vendored: 'included with Copse',
}

function describeInclusion(component: ThirdPartyComponent): string {
  if (component.partOf) return `Compiled into ${component.partOf}`
  const labels = component.shippedAs.map((as) => SHIPPED_AS_LABEL[as])
  const text = labels.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function licenseBody(component: ThirdPartyComponent, texts: readonly string[]): HTMLElement {
  const meta = el('p', { class: 'about-license-meta' }, describeInclusion(component))
  if (component.source) {
    meta.append(
      ' · ',
      el('a', { href: component.source, target: '_blank', rel: 'noopener noreferrer' }, 'Source'),
    )
  }
  const body = el('div', { class: 'about-license-body' }, meta)
  if (component.note) body.append(el('p', { class: 'about-license-note' }, component.note))
  for (const file of component.files) {
    body.append(
      el('div', { class: 'about-license-file-name' }, file.name),
      el('pre', { class: 'about-license-text' }, (texts[file.text] ?? '').trim()),
    )
  }
  return body
}

function componentRow(component: ThirdPartyComponent, texts: readonly string[]): HTMLElement {
  const summary = el(
    'summary',
    { class: 'about-license-summary' },
    el('span', { class: 'about-license-name' }, component.name),
    el('span', { class: 'about-license-version' }, component.version),
    el('span', { class: 'about-license-id' }, component.license),
  )
  const details = el('details', { class: 'about-license' }, summary)
  // Hundreds of rows, most never opened: build each licence text on first open.
  details.addEventListener(
    'toggle',
    () => {
      if (details.open && !details.querySelector('.about-license-body')) {
        details.append(licenseBody(component, texts))
      }
    },
    { passive: true },
  )
  return el(
    'li',
    { 'data-search': `${component.name} ${component.license}`.toLowerCase() },
    details,
  )
}

export function createAboutSection(api: ApiClient): AboutSection {
  const versionEl = el('span', { class: 'about-version' }, '…')
  const openButton = (label: string, kind: LicenseFileKind): HTMLButtonElement => {
    const button = el('button', { type: 'button', class: 'ui-btn ui-btn-secondary' }, label)
    button.dataset['licenseFile'] = kind
    button.addEventListener('click', () => {
      void api.about.openLicenseFile(kind).catch((err: unknown) => {
        statusEl.textContent = errorMessage(err)
      })
    })
    return button
  }

  const copse = el(
    'fieldset',
    { class: 'about-copse' },
    el('legend', {}, 'Copse'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Version ',
      versionEl,
      '. Copse is free software, licensed under the GNU Affero General Public License, version 3.',
    ),
    uiActions(openButton('View licence', 'copse'), { align: 'start' }),
  )

  const channelSelect = el(
    'select',
    { name: 'updateChannel' },
    el('option', { value: 'beta' }, 'Beta'),
    el('option', { value: 'stable' }, 'Stable'),
  )
  const channelStatus = el('p', {
    class: 'about-update-status',
    role: 'status',
    'aria-live': 'polite',
  })
  const updates = el(
    'fieldset',
    { class: 'about-updates' },
    el('legend', {}, 'Updates'),
    el(
      'label',
      { class: 'about-update-channel' },
      'Update channel',
      channelSelect,
      el(
        'span',
        { class: 'field-hint' },
        'Beta gets new features first; switch to Stable and Copse keeps installing betas until the next stable release, then installs only stable releases.',
      ),
    ),
    channelStatus,
  )
  let savedChannel: ReleaseChannel = 'beta'
  let installedChannel: ReleaseChannel = 'beta'
  channelSelect.addEventListener('change', () => {
    const value = channelSelect.value
    if (!isReleaseChannel(value)) return
    channelSelect.disabled = true
    void api.settings
      .set('updateChannel', value)
      .then(
        () => {
          savedChannel = value
          setInlineStatus(
            channelStatus,
            'ok',
            value === 'beta'
              ? 'Copse now updates to beta releases.'
              : installedChannel === 'stable'
                ? 'Copse now updates to stable releases only.'
                : 'Copse keeps updating to betas until the next stable release.',
          )
        },
        (err: unknown) => {
          channelSelect.value = savedChannel
          setInlineStatus(channelStatus, 'error', errorMessage(err))
        },
      )
      .finally(() => {
        channelSelect.disabled = false
      })
  })
  const showChannel = async (version: string): Promise<void> => {
    let channel: ReleaseChannel = 'beta'
    try {
      installedChannel = getReleaseChannel(version)
      channel = chosenUpdateChannel(await api.settings.get('updateChannel'), version).channel
    } catch {
      // A development build has no release channel of its own; show beta.
    }
    savedChannel = channel
    channelSelect.value = channel
  }

  const countEl = el('span', {}, 'the open-source components')
  const statusEl = el('p', { class: 'field-hint about-licenses-status', 'aria-live': 'polite' })
  const thirdParty = el(
    'fieldset',
    { class: 'about-third-party' },
    el('legend', {}, 'Open-source licences'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Copse is built with ',
      countEl,
      ' listed below, each used under its own licence. Select one to read its licence. ' +
        'The Chromium and Node.js components inside the Electron runtime are listed separately.',
    ),
    uiActions(
      openButton('Open all licences', 'third-party'),
      openButton('Chromium and Node.js notices', 'chromium'),
      { align: 'start' },
    ),
  )

  // Deliberately outside every <fieldset>: Settings search lifts whole
  // fieldsets, and a list naming 700 packages would match almost any query.
  const filter = el('input', {
    type: 'search',
    class: 'about-licenses-filter',
    placeholder: 'Filter by name or licence',
    'aria-label': 'Filter open-source components',
    autocomplete: 'off',
    spellcheck: 'false',
  })
  const list = el('ul', { class: 'about-licenses-list', 'aria-label': 'Open-source components' })
  const listHost = el('div', { class: 'about-licenses', hidden: true }, filter, statusEl, list)

  let total = 0
  const applyFilter = (): void => {
    const query = filter.value.trim().toLowerCase()
    let shown = 0
    for (const row of Array.from(list.children)) {
      if (!(row instanceof HTMLElement)) continue
      const match = query === '' || (row.dataset['search'] ?? '').includes(query)
      row.hidden = !match
      if (match) shown++
    }
    statusEl.textContent =
      query === ''
        ? `${String(total)} components`
        : `${String(shown)} of ${String(total)} components`
  }
  filter.addEventListener('input', applyFilter)
  filter.addEventListener('keydown', (event) => {
    // The section lives inside the Settings <form>: Enter would submit it.
    if (event.key === 'Enter') event.preventDefault()
  })

  const render = (report: ThirdPartyLicenseReport): void => {
    total = report.components.length
    countEl.textContent = `the ${String(total)} open-source components`
    list.replaceChildren(...report.components.map((c) => componentRow(c, report.texts)))
    listHost.hidden = false
    applyFilter()
  }

  let loaded: Promise<void> | null = null
  const refresh = (): Promise<void> => {
    loaded ??= api.about.getInfo().then(
      (info) => {
        versionEl.textContent = info.version
        void showChannel(info.version)
        if (info.report) {
          render(info.report)
        } else {
          statusEl.textContent =
            'This build has no licence report. Only a full build (pnpm build) generates one.'
          listHost.hidden = false
        }
      },
      (err: unknown) => {
        loaded = null
        statusEl.textContent = errorMessage(err)
        listHost.hidden = false
      },
    )
    return loaded
  }

  const root = el('div', { class: 'about-section' }, copse, updates, thirdParty, listHost)
  return { root, refresh }
}
