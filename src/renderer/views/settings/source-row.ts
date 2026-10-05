function makeSourceRowTitle(
  title: string,
  action?: { label: string; run: () => void },
): HTMLElement {
  if (!action) {
    const span = document.createElement('span')
    span.className = 'sources-row-title'
    span.textContent = title
    return span
  }
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'sources-row-title sources-row-title-btn'
  button.textContent = title
  button.title = action.label
  button.setAttribute('aria-label', action.label)
  button.addEventListener('click', action.run)
  return button
}

export function makeSourceRow(
  title: string,
  badge: string | null,
  detail: string | null,
  opts: {
    badgeClass?: string | undefined
    /** Extra badges rendered after the scope badge (e.g. unsupported / error). */
    extraBadges?: Array<{ text: string; className: string }>
    /** Native tooltip (also used when hover-detail CSS is unavailable). */
    titleAttr?: string | undefined
    /** Path/origin shown only while the row is hovered or focused. */
    hoverDetail?: string | undefined
    /** Makes the row title a button (e.g. open the file in the preview dialog). */
    titleAction?: { label: string; run: () => void }
  } = {},
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'sources-row'
  if (opts.titleAttr) row.title = opts.titleAttr
  const header = document.createElement('div')
  header.className = 'sources-row-header'
  // Title + optional hover path share one flex slot so a long origin cannot
  // inflate the row / settings scrollport (min-content of a bare path would
  // otherwise win over the section width).
  const primary = document.createElement('div')
  primary.className = 'sources-row-primary'
  const titleEl = makeSourceRowTitle(title, opts.titleAction)
  primary.append(titleEl)
  // Origin sits in the primary gutter (title → badge) on hover so the row
  // height never grows; long paths ellipsize from the left. `<bdi>` keeps
  // the path LTR so a leading `/` doesn't flip to the end under `direction:
  // rtl` (same left-elide trick as `.git-change-path`).
  if (opts.hoverDetail) {
    const hoverEl = document.createElement('span')
    hoverEl.className = 'sources-row-hover-detail'
    const pathEl = document.createElement('bdi')
    pathEl.textContent = opts.hoverDetail
    hoverEl.append(pathEl)
    primary.append(hoverEl)
  }
  header.append(primary)
  if (badge) {
    const badgeEl = document.createElement('span')
    badgeEl.className = opts.badgeClass
      ? `ui-badge sources-badge ${opts.badgeClass}`
      : 'ui-badge sources-badge'
    badgeEl.textContent = badge
    header.append(badgeEl)
  }
  for (const extra of opts.extraBadges ?? []) {
    const badgeEl = document.createElement('span')
    badgeEl.className = `ui-badge sources-badge ${extra.className}`
    badgeEl.textContent = extra.text
    header.append(badgeEl)
  }
  row.append(header)
  if (detail) {
    const detailEl = document.createElement('div')
    detailEl.className = 'sources-row-detail'
    detailEl.textContent = detail
    row.append(detailEl)
  }
  return row
}
