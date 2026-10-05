import { errorMessage } from '@shared/errors.ts'
import { BUNDLED_PLUGIN_CATALOG } from '@shared/plugin-catalog.generated.ts'
import type { PluginInstallRecord } from '@shared/types/plugin-installs.ts'

const PAGE_SIZE = 16

type CatalogEntry = (typeof BUNDLED_PLUGIN_CATALOG.entries)[number]

export interface PluginCatalogInstalledState {
  cursor: readonly string[]
  bundledCursor: readonly string[]
  managed: readonly PluginInstallRecord[]
}

export interface PluginCatalogBrowserOptions {
  reviewInstall(catalogId: string): Promise<void>
  rollback(record: PluginInstallRecord): Promise<void>
  uninstall(record: PluginInstallRecord): Promise<void>
}

export interface PluginCatalogBrowser {
  readonly element: HTMLElement
  focusSearch(): void
  updateInstalled(state: PluginCatalogInstalledState): void
}

function displayName(entry: CatalogEntry): string {
  return (
    entry.names.find((name) => /[A-Z ]/.test(name)) ??
    entry.names[0] ??
    entry.listings[0]?.name ??
    entry.id
  )
}

function publisher(entry: CatalogEntry): string {
  if (entry.publisher) return entry.publisher
  return new URL(entry.repository).pathname.split('/').filter(Boolean)[0] ?? 'Unknown publisher'
}

function sourceUrl(entry: CatalogEntry): string {
  if (!entry.revision) return entry.repository
  const suffix = entry.path ? `/${entry.path}` : ''
  return `${entry.repository}/tree/${entry.revision}${suffix}`
}

function searchText(entry: CatalogEntry): string {
  return [
    ...entry.names,
    entry.description,
    entry.publisher ?? '',
    ...entry.keywords,
    ...entry.listings.map((listing) => listing.id),
  ]
    .join(' ')
    .toLocaleLowerCase()
}

function isCursorInstalled(entry: CatalogEntry, cursorNames: ReadonlySet<string>): boolean {
  return entry.listings.some(
    (listing) => listing.format === 'cursor' && cursorNames.has(listing.name.toLocaleLowerCase()),
  )
}

function makeBadge(label: string, className = ''): HTMLElement {
  const badge = document.createElement('span')
  badge.className = `ui-badge plugin-catalog-badge ${className}`.trim()
  badge.textContent = label
  return badge
}

function makeAction(
  label: string,
  run: () => Promise<void>,
  card: HTMLElement,
  operationStatus: HTMLElement,
  className = 'ui-btn-secondary',
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `ui-btn ${className} plugin-catalog-action`
  button.textContent = label
  button.addEventListener('click', () => {
    button.disabled = true
    card.setAttribute('aria-busy', 'true')
    operationStatus.textContent = `${label}…`
    void run()
      .then(() => {
        operationStatus.textContent = ''
      })
      .catch((error: unknown) => {
        operationStatus.textContent = errorMessage(error)
      })
      .finally(() => {
        button.disabled = false
        card.removeAttribute('aria-busy')
      })
  })
  return button
}

function makeCatalogCard(
  entry: CatalogEntry,
  cursorInstalled: boolean,
  managed: PluginInstallRecord | undefined,
  options: PluginCatalogBrowserOptions,
): HTMLElement {
  const installed = cursorInstalled || managed !== undefined
  const updateAvailable =
    managed !== undefined && entry.revision !== null && managed.source.revision !== entry.revision
  const card = document.createElement('article')
  card.className = 'plugin-catalog-card'
  card.dataset['catalogId'] = entry.id
  card.dataset['installed'] = installed ? 'true' : 'false'

  const icon = document.createElement('span')
  icon.className = 'plugin-icon plugin-catalog-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = (displayName(entry).trim()[0] ?? '?').toLocaleUpperCase()

  const title = document.createElement('div')
  title.className = 'plugin-catalog-title'
  const publisherEl = document.createElement('span')
  publisherEl.className = 'plugin-catalog-publisher'
  publisherEl.textContent = publisher(entry)
  const name = document.createElement('span')
  name.className = 'plugin-name'
  name.textContent = displayName(entry)
  title.append(publisherEl, name)

  const badges = document.createElement('div')
  badges.className = 'plugin-catalog-status'
  if (installed) badges.append(makeBadge('Installed', 'plugin-catalog-badge-installed'))
  if (updateAvailable) badges.append(makeBadge('Update available', 'plugin-catalog-badge-update'))
  badges.append(makeBadge('Untested'))
  if (!entry.revision) badges.append(makeBadge('Unpinned', 'plugin-catalog-badge-warning'))

  const header = document.createElement('div')
  header.className = 'plugin-catalog-card-header'
  header.append(icon, title, badges)
  card.append(header)

  const description = document.createElement('p')
  description.className = 'plugin-catalog-description'
  description.textContent = entry.description || 'No description supplied by the catalogue.'
  card.append(description)

  if (entry.keywords.length > 0) {
    const keywords = document.createElement('div')
    keywords.className = 'plugin-chips plugin-catalog-keywords'
    for (const keyword of entry.keywords.slice(0, 4)) {
      const chip = document.createElement('span')
      chip.className = 'plugin-chip'
      chip.textContent = keyword
      keywords.append(chip)
    }
    card.append(keywords)
  }

  const operationStatus = document.createElement('span')
  operationStatus.className = 'plugin-catalog-operation-status'
  operationStatus.setAttribute('role', 'status')

  const footer = document.createElement('div')
  footer.className = 'plugin-catalog-card-footer'
  const provenance = document.createElement('span')
  provenance.className = 'plugin-catalog-provenance'
  provenance.textContent = [...new Set(entry.listings.map((listing) => listing.format))]
    .map((format) => (format === 'claude' ? 'Claude' : 'Cursor'))
    .join(' · ')

  const actions = document.createElement('div')
  actions.className = 'plugin-catalog-actions'
  const link = document.createElement('a')
  link.className = 'ui-btn ui-btn-secondary plugin-catalog-source-link'
  link.href = sourceUrl(entry)
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = 'View source'
  actions.append(link)

  if (entry.revision && !cursorInstalled && (!managed || updateAvailable)) {
    actions.prepend(
      makeAction(
        managed ? 'Review update' : 'Review install',
        () => options.reviewInstall(entry.id),
        card,
        operationStatus,
        'ui-btn-primary',
      ),
    )
  }
  if (managed?.previousPin) {
    actions.prepend(makeAction('Roll back', () => options.rollback(managed), card, operationStatus))
  }
  if (managed) {
    actions.append(
      makeAction(
        'Uninstall',
        () => options.uninstall(managed),
        card,
        operationStatus,
        'ui-btn-danger',
      ),
    )
  }

  footer.append(provenance, actions)
  card.append(operationStatus, footer)
  return card
}

export function createPluginCatalogBrowser(
  options: PluginCatalogBrowserOptions,
): PluginCatalogBrowser {
  const root = document.createElement('div')
  root.className = 'plugin-catalog-browser'

  const intro = document.createElement('p')
  intro.className = 'plugin-catalog-intro'
  intro.textContent =
    `${String(BUNDLED_PLUGIN_CATALOG.entries.length)} packages from ` +
    `${String(BUNDLED_PLUGIN_CATALOG.sources.length)} pinned catalogues. ` +
    'Listings are untested in Copse until their package is reviewed.'

  const searchLabel = document.createElement('label')
  searchLabel.className = 'plugin-catalog-search'
  const searchCaption = document.createElement('span')
  searchCaption.className = 'sr-only'
  searchCaption.textContent = 'Search available plugins'
  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'settings-search-input plugin-catalog-search-input'
  search.placeholder = 'Search plugins, publishers, or tasks…'
  search.autocomplete = 'off'
  search.spellcheck = false
  search.setAttribute('aria-label', 'Search available plugins')
  searchLabel.append(searchCaption, search)

  const resultStatus = document.createElement('p')
  resultStatus.className = 'plugin-catalog-result-status'
  resultStatus.setAttribute('aria-live', 'polite')

  const results = document.createElement('div')
  results.className = 'plugin-catalog-results'

  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'ui-btn ui-btn-secondary plugin-catalog-more'
  more.textContent = 'Show more'

  root.append(intro, searchLabel, resultStatus, results, more)

  let visibleCount = PAGE_SIZE
  let cursorNames = new Set<string>()
  let managedByCatalogId = new Map<string, PluginInstallRecord>()

  const render = (): void => {
    const query = search.value.trim().toLocaleLowerCase()
    const matched = BUNDLED_PLUGIN_CATALOG.entries.filter(
      (entry) => query === '' || searchText(entry).includes(query),
    )
    const visible = matched.slice(0, visibleCount)
    results.replaceChildren(
      ...visible.map((entry) =>
        makeCatalogCard(
          entry,
          isCursorInstalled(entry, cursorNames),
          managedByCatalogId.get(entry.id),
          options,
        ),
      ),
    )
    if (matched.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'plugins-empty'
      empty.textContent = 'No catalogue plugins match this search.'
      results.append(empty)
    }
    resultStatus.textContent =
      matched.length === visible.length
        ? `${String(matched.length)} plugin${matched.length === 1 ? '' : 's'}`
        : `Showing ${String(visible.length)} of ${String(matched.length)} plugins`
    more.hidden = visible.length >= matched.length
  }

  search.addEventListener('input', () => {
    visibleCount = PAGE_SIZE
    render()
  })
  more.addEventListener('click', () => {
    visibleCount += PAGE_SIZE
    render()
  })

  render()

  return {
    element: root,
    focusSearch: (): void => {
      search.focus()
    },
    updateInstalled: (state): void => {
      cursorNames = new Set(
        [...state.cursor, ...state.bundledCursor].map((name) => name.toLocaleLowerCase()),
      )
      managedByCatalogId = new Map(state.managed.map((record) => [record.catalogId, record]))
      render()
    },
  }
}
