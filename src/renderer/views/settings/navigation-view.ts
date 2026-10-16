import { qsRequired } from '../../dom/helpers.ts'
import { isSettingsSection, type SettingsSection } from './navigation.ts'
export interface SettingsNavigation {
  show(id: SettingsSection): void
  reset(id: SettingsSection): void
  refreshHeadings(): void
  active(): SettingsSection
  reveal(control: HTMLElement): void
}
export function createSettingsNavigation(
  overlay: HTMLElement,
  onVisible: (sections: SettingsSection[]) => void,
): SettingsNavigation {
  const navBtns = overlay.querySelectorAll<HTMLButtonElement>('.settings-nav-btn')
  const sections = overlay.querySelectorAll<HTMLElement>('.settings-section')
  const contentEl = qsRequired(overlay, '.settings-content')
  const searchInput = qsRequired<HTMLInputElement>(overlay, '#settings-search-input')
  const searchEmpty = qsRequired(overlay, '#settings-search-empty')
  const searchResults = qsRequired(overlay, '#settings-search-results')
  // The section a nav button last selected, restored when a search is cleared.
  let activeSection: SettingsSection = 'general'
  // Blocks lifted into the results list, each with the comment node marking the
  // spot to drop it back into when the search is cleared.
  let liftedBlocks: { node: HTMLElement; marker: Comment }[] = []
  function showSection(id: SettingsSection): void {
    activeSection = id
    overlay.dispatchEvent(new Event('settings-section-shown'))
    navBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset['section'] === id))
    sections.forEach((sec) => sec.classList.toggle('active', sec.dataset['section'] === id))
    renderNavSubheadings(id)
  }

  // The open section's group headings, mirrored into the sidebar under its row.
  // General and Appearance are several screens tall, so the nav doubles as that
  // section's contents: what is on this page, and a click to jump to it. Only
  // the open section expands, and the list is read back off the DOM each time —
  // so a group that is hidden (developer-only) or mounted by a panel never has
  // to be registered in a second place to show up here.
  let navSubheadings: HTMLElement | null = null

  function clearNavSubheadings(): void {
    navSubheadings?.remove()
    navSubheadings = null
  }

  function renderNavSubheadings(id: SettingsSection): void {
    clearNavSubheadings()
    const navBtn = Array.from(navBtns).find((btn) => btn.dataset['section'] === id)
    const section = Array.from(sections).find((sec) => sec.dataset['section'] === id)
    if (!navBtn || !section) return
    const list = document.createElement('div')
    list.className = 'settings-nav-subheadings'
    for (const block of topLevelBlocks(section)) {
      // A hidden ancestor counts too: the cloud-agent auth cards are parked in a
      // hidden template until the Providers panel moves them under a provider.
      if (block.closest('[hidden]')) continue
      const label = block.querySelector('legend')?.textContent.trim()
      if (!label) continue
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'settings-nav-subheading'
      btn.textContent = label
      btn.addEventListener('click', () => {
        block.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
      list.append(btn)
    }
    if (list.childElementCount === 0) return
    navBtn.after(list)
    navSubheadings = list
  }

  // A settings "block" is a top-level fieldset — one not nested inside another
  // (LM Studio sits inside Local providers, so it isn't its own block).
  function topLevelBlocks(root: ParentNode): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('fieldset')).filter(
      (fs) => !fs.parentElement?.closest('fieldset'),
    )
  }

  // Return each lifted block to the marker left in its original position.
  function restoreLiftedBlocks(): void {
    for (const { node, marker } of liftedBlocks) marker.replaceWith(node)
    liftedBlocks = []
  }

  /**
   * Cross-section search: type text and every settings block (a top-level
   * `<fieldset>`) whose text contains it is collected into one results list, no
   * matter which section it lives in. Blocks are shown whole — never cropped —
   * and ranked so a hit in the block's own heading (its legend) sorts above one
   * that only matched body text, since the heading names what the block is. With
   * the box empty, the normal one-section-at-a-time view is restored.
   */
  function applySearch(raw: string): void {
    // Always start from a clean slate so each keystroke re-ranks from scratch.
    restoreLiftedBlocks()
    const query = raw.trim().toLowerCase()
    if (!query) {
      contentEl.classList.remove('settings-searching')
      searchEmpty.hidden = true
      // `restoreLiftedBlocks()` above returns every lifted block to the marker
      // left in its section. Anything still parked here lost its marker, and the
      // `replaceChildren()` below is about to destroy it — taking a whole
      // fieldset out of its section for the life of the renderer, which reads
      // downstream as "that setting isn't displayed". Name it before it goes.
      for (const orphan of Array.from(searchResults.children)) {
        console.error(
          '[settings] search results still held a block after restore:',
          orphan.querySelector('legend')?.textContent ?? orphan.className,
        )
      }
      searchResults.replaceChildren()
      showSection(activeSection)
      onVisible([activeSection])
      return
    }

    contentEl.classList.add('settings-searching')
    // Results are lifted out of their sections, so the open section's contents
    // list no longer describes what is on screen. Drop it until search clears.
    clearNavSubheadings()
    const matches: { node: HTMLElement; rank: number }[] = []
    sections.forEach((sec) => {
      for (const block of topLevelBlocks(sec)) {
        if (block.hidden) continue
        if (!block.textContent.toLowerCase().includes(query)) continue
        const legend = block.querySelector('legend')?.textContent.toLowerCase() ?? ''
        matches.push({ node: block, rank: legend.includes(query) ? 0 : 1 })
      }
    })
    // Stable sort (legend matches first) keeps document order within each rank.
    onVisible([
      ...new Set(
        matches.flatMap(({ node }) => {
          const id = node.closest<HTMLElement>('.settings-section')?.dataset['section']
          return isSettingsSection(id) ? [id] : []
        }),
      ),
    ])
    matches.sort((a, b) => a.rank - b.rank)
    for (const { node } of matches) {
      const marker = document.createComment('lifted settings block')
      node.replaceWith(marker)
      searchResults.append(node)
      liftedBlocks.push({ node, marker })
    }
    if (matches.length === 0) {
      searchEmpty.textContent = `No settings match “${raw.trim()}”.`
      searchEmpty.hidden = false
    } else {
      searchEmpty.hidden = true
    }
  }

  searchInput.addEventListener('input', () => {
    applySearch(searchInput.value)
  })

  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset['section']
      if (isSettingsSection(id)) {
        // Selecting a section is an explicit exit from search results.
        if (searchInput.value) {
          searchInput.value = ''
          applySearch('')
        }
        showSection(id)
        onVisible([id])
      }
    })
  })

  return {
    show: showSection,
    reset(id): void {
      searchInput.value = ''
      restoreLiftedBlocks()
      applySearch('')
      showSection(id)
      searchInput.focus()
    },
    refreshHeadings: (): void => {
      if (searchInput.value.trim()) return
      renderNavSubheadings(activeSection)
    },
    active: (): SettingsSection => activeSection,
    reveal(control): void {
      searchInput.value = ''
      restoreLiftedBlocks()
      applySearch('')
      const section = control.closest<HTMLElement>('.settings-section')?.dataset['section']
      if (isSettingsSection(section)) {
        showSection(section)
        onVisible([section])
      }
      let ancestor = control.parentElement
      while (ancestor && ancestor !== overlay) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
        ancestor = ancestor.parentElement
      }
      control.scrollIntoView({ block: 'center' })
      control.focus()
    },
  }
}
