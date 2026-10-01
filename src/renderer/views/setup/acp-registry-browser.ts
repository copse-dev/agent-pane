import type { ApiClient } from '../../../preload/api.d.ts'
import {
  ACP_REGISTRY_URL,
  type AcpRegistryEntry,
  type AcpRegistryListing,
} from '@shared/acp-registry.ts'
import { el, clear } from '../../dom/helpers.ts'

/** Explicit discovery only. The caller opens a draft; this component never saves or probes. */
export function createAcpRegistryBrowser(
  api: ApiClient,
  onChoose: (entry: AcpRegistryEntry) => void,
): HTMLElement {
  let listing: AcpRegistryListing | undefined
  let visibleCount = 20
  let loading = false
  const toggle = el(
    'button',
    {
      type: 'button',
      class: 'provider-secondary acp-registry-toggle',
      'aria-expanded': 'false',
    },
    'Browse agent registry',
  )
  const refresh = el('button', { type: 'button', class: 'provider-secondary' }, 'Refresh registry')
  const search = el('input', {
    type: 'search',
    placeholder: 'Search agents',
    'aria-label': 'Search agent registry',
  })
  const status = el('p', { class: 'field-hint', role: 'status' })
  const results = el('div', { class: 'acp-registry-results' })
  const more = el(
    'button',
    { type: 'button', class: 'provider-secondary', hidden: true },
    'Show more',
  )
  const content = el(
    'div',
    { class: 'acp-registry-content', hidden: true },
    el(
      'p',
      { class: 'field-hint' },
      'Community registry entries are unverified by Copse. Browsing does not install or start agents. ' +
        'Review the publisher’s authentication, billing and platform requirements before enabling one.',
    ),
    el('div', { class: 'acp-registry-controls' }, search, refresh),
    status,
    results,
    more,
    el(
      'a',
      { href: ACP_REGISTRY_URL, target: '_blank', rel: 'noopener noreferrer' },
      'Registry source',
    ),
  )

  function renderResults(): void {
    clear(results)
    if (!listing) return
    const query = search.value.trim().toLowerCase()
    const matches = listing.entries.filter((entry) =>
      `${entry.title} ${entry.id} ${entry.description} ${entry.packages.join(' ')}`
        .toLowerCase()
        .includes(query),
    )
    for (const entry of matches.slice(0, visibleCount)) {
      const choose = el(
        'button',
        { type: 'button', class: 'provider-secondary' },
        'Review configuration',
      )
      choose.addEventListener('click', () => {
        content.hidden = true
        toggle.setAttribute('aria-expanded', 'false')
        toggle.textContent = 'Browse agent registry'
        onChoose(entry)
      })
      const row = el(
        'article',
        { class: 'acp-registry-entry', 'data-registry-id': entry.id },
        el(
          'div',
          { class: 'acp-registry-entry-head' },
          el('strong', {}, entry.title),
          el('span', { class: 'field-hint' }, `v${entry.version} · Unverified`),
        ),
        el('p', {}, entry.description),
        el(
          'p',
          { class: 'field-hint acp-registry-install-status' },
          entry.installedPath
            ? `Executable found: ${entry.installedPath}`
            : entry.command
              ? `Executable not found on PATH: ${entry.command}`
              : 'Installed status unknown: this entry does not identify a direct executable for this platform.',
        ),
        ...entry.packages.map((pkg) =>
          el('div', { class: 'acp-registry-package' }, el('code', {}, pkg)),
        ),
        ...(entry.platforms.length
          ? [el('p', { class: 'field-hint' }, `Binary targets: ${entry.platforms.join(', ')}`)]
          : []),
        el(
          'div',
          { class: 'provider-actions' },
          choose,
          ...(entry.website
            ? [
                el(
                  'a',
                  { href: entry.website, target: '_blank', rel: 'noopener noreferrer' },
                  'Publisher documentation',
                ),
              ]
            : []),
        ),
      )
      results.append(row)
    }
    if (!matches.length)
      results.append(
        el(
          'p',
          { class: 'field-hint' },
          query ? 'No agents match your search.' : 'The registry has no usable entries.',
        ),
      )
    more.hidden = matches.length <= visibleCount
  }

  async function load(force = false): Promise<void> {
    if (loading) return
    loading = true
    refresh.disabled = true
    status.textContent = 'Loading agent registry…'
    try {
      listing = await api.acp.browseRegistry(force)
      status.textContent =
        `${String(listing.entries.length)} registry entries` +
        (listing.skipped
          ? ` · ${String(listing.skipped)} invalid or duplicate entries skipped`
          : '') +
        '. Executable presence does not verify compatibility.'
      renderResults()
    } catch (error) {
      status.textContent =
        `Could not load the agent registry. ${error instanceof Error ? error.message : 'Try again.'}` +
        (listing
          ? ' Previously loaded entries are still shown.'
          : ' Use Refresh registry to retry, or configure a custom agent below.')
    } finally {
      loading = false
      refresh.disabled = false
    }
  }

  toggle.addEventListener('click', () => {
    content.hidden = !content.hidden
    toggle.setAttribute('aria-expanded', String(!content.hidden))
    toggle.textContent = content.hidden ? 'Browse agent registry' : 'Hide agent registry'
    if (!content.hidden && !listing) void load()
  })
  refresh.addEventListener('click', () => void load(true))
  search.addEventListener('input', () => {
    visibleCount = 20
    renderResults()
  })
  more.addEventListener('click', () => {
    visibleCount += 20
    renderResults()
  })
  return el(
    'section',
    { class: 'acp-registry-browser', 'aria-label': 'Agent registry' },
    toggle,
    content,
  )
}
