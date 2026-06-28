import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { el } from '../dom/helpers.ts'
import { registerTerminalSelectionToChatShortcut } from '../terminal/selection-to-chat.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { installTerminalFileLinks, type TerminalFileLinks } from './terminal-file-links.ts'

const XTERM_THEME = {
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    selectionBackground: '#264f78',
  },
  light: {
    background: '#ffffff',
    foreground: '#1e1e1e',
    cursor: '#1e1e1e',
    selectionBackground: '#add6ff',
  },
} as const

interface TerminalTab {
  id: string
  label: string
  labelSpan: HTMLElement
  panel: HTMLElement
  container: HTMLElement
  tabBtn: HTMLButtonElement
  term: Terminal
  fitAddon: FitAddon
  fileLinks: TerminalFileLinks
  sessionId: string | null
  creating: boolean
  pendingInput: string[]
  termOpened: boolean
  /** True once the user has submitted a command, gating auto-naming. */
  commandRan: boolean
  /** True once the LLM has produced a label (don't auto-name again). */
  autoNamed: boolean
  /** True once the user manually renamed the tab (never auto-name after). */
  renamed: boolean
  /** True while a naming request is in flight. */
  naming: boolean
  nameTimer: ReturnType<typeof setTimeout> | null
}

function terminalModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'terminal'
}

export function mountTerminalsPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const listHeader = el('div', { class: 'terminals-list-header' }, 'Shells')
  const newBtn = el(
    'button',
    {
      type: 'button',
      class: 'terminals-new-btn',
      'aria-label': 'New terminal',
      title: 'New terminal',
    },
    '+',
  )
  listHeader.append(newBtn)

  const tabsWrap = el('div', { class: 'terminals-list' })
  listRoot.append(listHeader, tabsWrap)

  const body = el('div', { class: 'terminals-body' })
  viewerRoot.append(body)

  const tabs = new Map<string, TerminalTab>()
  let activeTabId: string | null = null
  let tabCounter = 0

  const unsubOutput = api.terminal.onOutput((id, data) => {
    for (const tab of tabs.values()) {
      if (tab.sessionId === id) {
        tab.term.write(data)
        tab.fileLinks.refresh()
        if (tab.commandRan) scheduleAutoName(tab)
      }
    }
  })

  const unsubExit = api.terminal.onExit((id, code) => {
    const tab = [...tabs.values()].find((t) => t.sessionId === id)
    if (!tab) return
    tab.term.writeln(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m`)
    tab.sessionId = null
  })

  function createXterm(): { term: Terminal; fitAddon: FitAddon } {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: store.getState().fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: XTERM_THEME[store.getState().theme],
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    return { term, fitAddon }
  }

  function setTabLabel(tab: TerminalTab, label: string) {
    tab.label = label
    tab.labelSpan.textContent = label
    tab.tabBtn.title = label
  }

  // Read the recent visible/scrollback text from the xterm buffer (ANSI-free),
  // for handing to the small-tasks model when auto-naming.
  function readTerminalText(tab: TerminalTab): string {
    const buf = tab.term.buffer.active
    const end = buf.length
    const start = Math.max(0, end - 200)
    const lines: string[] = []
    for (let i = start; i < end; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    return lines.join('\n').trim()
  }

  async function autoNameTab(tab: TerminalTab) {
    if (tab.renamed || tab.autoNamed || tab.naming) return
    const text = readTerminalText(tab)
    if (text.length < 8) return
    tab.naming = true
    try {
      const title = await api.agent.suggestTerminalTitle(text)
      if (title && !tab.renamed) {
        setTabLabel(tab, title)
        tab.autoNamed = true
      }
    } catch {
      // Leave the default "Terminal N" label in place.
    } finally {
      tab.naming = false
    }
  }

  // Debounce naming until terminal output settles after a command.
  function scheduleAutoName(tab: TerminalTab) {
    if (tab.renamed || tab.autoNamed || tab.naming) return
    if (tab.nameTimer != null) clearTimeout(tab.nameTimer)
    tab.nameTimer = setTimeout(() => {
      tab.nameTimer = null
      void autoNameTab(tab)
    }, 2500)
  }

  // Replace the tab label with an inline text field for manual renaming.
  function beginRename(tab: TerminalTab) {
    if (tab.nameTimer != null) {
      clearTimeout(tab.nameTimer)
      tab.nameTimer = null
    }
    const input = el('input', {
      type: 'text',
      class: 'terminals-tab-rename',
    }) as HTMLInputElement
    input.value = tab.label
    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      const next = input.value.trim()
      input.replaceWith(tab.labelSpan)
      if (save && next) {
        setTabLabel(tab, next)
        tab.renamed = true
      }
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    for (const evt of ['click', 'dblclick', 'mousedown'] as const) {
      input.addEventListener(evt, (e) => e.stopPropagation())
    }
    tab.labelSpan.replaceWith(input)
    input.focus()
    input.select()
  }

  function openTerminalSurface(tab: TerminalTab) {
    if (tab.termOpened) return
    tab.term.open(tab.container)
    tab.termOpened = true
  }

  async function flushPendingInput(tab: TerminalTab) {
    if (!tab.sessionId) return
    while (tab.pendingInput.length > 0) {
      const chunk = tab.pendingInput.shift()!
      await api.terminal.write(tab.sessionId, chunk)
    }
  }

  async function ensureSession(tab: TerminalTab) {
    if (tab.sessionId || tab.creating) return
    if (!store.getState().workspaceRoot) {
      tab.term.writeln('\x1b[90mOpen a folder to use the terminal.\x1b[0m')
      return
    }
    tab.creating = true
    try {
      openTerminalSurface(tab)
      fitTab(tab)
      tab.sessionId = await api.terminal.create(tab.term.cols, tab.term.rows)
      await flushPendingInput(tab)
    } catch (err) {
      tab.term.writeln(`\x1b[31mFailed to start terminal: ${String(err)}\x1b[0m`)
    } finally {
      tab.creating = false
    }
  }

  async function destroySession(tab: TerminalTab) {
    if (!tab.sessionId) return
    const old = tab.sessionId
    tab.sessionId = null
    await api.terminal.destroy(old)
  }

  function fitTab(tab: TerminalTab) {
    if (!terminalModeActive(store) || !tab.panel.classList.contains('is-active') || !tab.termOpened)
      return
    try {
      tab.fitAddon.fit()
      if (tab.sessionId && tab.term.cols > 0 && tab.term.rows > 0) {
        void api.terminal.resize(tab.sessionId, tab.term.cols, tab.term.rows)
      }
    } catch {
      // FitAddon throws when the container has zero dimensions.
    }
  }

  function focusTab(tab: TerminalTab) {
    openTerminalSurface(tab)
    fitTab(tab)
    tab.term.focus()
  }

  function setActiveTab(tabId: string) {
    if (activeTabId === tabId) return
    activeTabId = tabId
    for (const tab of tabs.values()) {
      const active = tab.id === tabId
      tab.panel.classList.toggle('is-active', active)
      tab.tabBtn.classList.toggle('is-active', active)
    }
    const tab = tabs.get(tabId)
    if (tab && terminalModeActive(store)) {
      void ensureSession(tab)
      requestAnimationFrame(() => {
        fitTab(tab)
        focusTab(tab)
      })
    }
  }

  function wireTabInput(tab: TerminalTab) {
    // Cmd/Ctrl+L attaches the terminal's current selection to the chat so
    // command output can be referenced as a prompt attachment.
    registerTerminalSelectionToChatShortcut(tab.term, () => tab.label)
    tab.term.onData((data) => {
      if (data.includes('\r')) {
        tab.commandRan = true
        scheduleAutoName(tab)
      }
      if (!tab.sessionId) {
        tab.pendingInput.push(data)
        void ensureSession(tab)
        return
      }
      void api.terminal.write(tab.sessionId, data)
    })
    tab.container.addEventListener('mousedown', () => {
      if (activeTabId === tab.id) focusTab(tab)
    })
  }

  function addTab(options?: { activate?: boolean }): string {
    tabCounter += 1
    const id = crypto.randomUUID()
    const label = `Terminal ${tabCounter}`
    const closeBtn = el(
      'span',
      {
        class: 'terminals-tab-close',
        role: 'button',
        'aria-label': 'Close terminal',
        title: 'Close',
      },
      '×',
    )
    const labelSpan = el('span', { class: 'terminals-tab-label' }, label)
    const tabBtn = el(
      'button',
      { type: 'button', class: 'terminals-tab', 'data-tab-id': id, title: label },
      labelSpan,
      closeBtn,
    ) as HTMLButtonElement

    const panel = el('div', { class: 'terminals-tab-panel', 'data-tab-id': id })
    const container = el('div', { class: 'terminal-container' })
    panel.append(container)

    const { term, fitAddon } = createXterm()
    const fileLinks = installTerminalFileLinks(term, store, api)
    const tab: TerminalTab = {
      id,
      label,
      labelSpan,
      panel,
      container,
      tabBtn,
      term,
      fitAddon,
      fileLinks,
      sessionId: null,
      creating: false,
      pendingInput: [],
      termOpened: false,
      commandRan: false,
      autoNamed: false,
      renamed: false,
      naming: false,
      nameTimer: null,
    }

    tabBtn.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.terminals-tab-close')) return
      setActiveTab(id)
    })
    labelSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      beginRename(tab)
    })
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void removeTab(id)
    })

    wireTabInput(tab)
    tabs.set(id, tab)
    tabsWrap.append(tabBtn)
    body.append(panel)

    if (options?.activate !== false || !activeTabId) setActiveTab(id)
    if (terminalModeActive(store)) void ensureSession(tab)
    return id
  }

  async function removeTab(tabId: string) {
    const tab = tabs.get(tabId)
    if (!tab) return
    if (tab.nameTimer != null) clearTimeout(tab.nameTimer)
    tab.fileLinks.dispose()
    await destroySession(tab)
    tab.term.dispose()
    tab.tabBtn.remove()
    tab.panel.remove()
    tabs.delete(tabId)

    if (activeTabId !== tabId) return
    const remaining = [...tabs.keys()]
    if (remaining.length > 0) {
      setActiveTab(remaining[remaining.length - 1]!)
    } else {
      activeTabId = null
      if (terminalModeActive(store)) addTab()
    }
  }

  async function restartAllSessions() {
    for (const tab of tabs.values()) {
      await destroySession(tab)
      tab.term.clear()
      if (terminalModeActive(store) && activeTabId === tab.id) {
        await ensureSession(tab)
      }
    }
  }

  const resizeObserver = new ResizeObserver(() => {
    const tab = activeTabId ? tabs.get(activeTabId) : null
    if (tab) fitTab(tab)
  })

  function onTerminalModeChange() {
    const active = terminalModeActive(store)
    if (active) {
      if (tabs.size === 0) addTab()
      const tab = activeTabId ? tabs.get(activeTabId) : null
      if (tab) {
        resizeObserver.observe(tab.container)
        openTerminalSurface(tab)
        fitTab(tab)
        void ensureSession(tab)
        requestAnimationFrame(() => focusTab(tab))
      }
    } else {
      resizeObserver.disconnect()
    }
  }

  function onThemeChange(theme: 'light' | 'dark') {
    for (const tab of tabs.values()) {
      tab.term.options.theme = XTERM_THEME[theme]
    }
  }

  function onFontSizeChange() {
    const size = store.getState().fontSize
    for (const tab of tabs.values()) {
      tab.term.options.fontSize = size
    }
    const tab = activeTabId ? tabs.get(activeTabId) : null
    if (tab) fitTab(tab)
  }

  newBtn.addEventListener('click', () => addTab())

  onTerminalModeChange()

  const unsubs = [
    store.on('right_panel_mode_changed', onTerminalModeChange),
    store.on('files_pane_changed', onTerminalModeChange),
    store.on('theme_changed', onThemeChange),
    store.on('settings_changed', onFontSizeChange),
    store.on('workspace_changed', () => {
      if (terminalModeActive(store)) void restartAllSessions()
    }),
  ]

  return () => {
    unsubs.forEach((u) => u())
    resizeObserver.disconnect()
    unsubOutput()
    unsubExit()
    void (async () => {
      for (const tab of tabs.values()) {
        if (tab.nameTimer != null) clearTimeout(tab.nameTimer)
        tab.fileLinks.dispose()
        await destroySession(tab)
        tab.term.dispose()
      }
      tabs.clear()
    })()
  }
}
