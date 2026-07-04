import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { el } from '../dom/helpers.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { registerTerminalSelectionToChatShortcut } from '../terminal/selection-to-chat.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { installTerminalFileLinks, type TerminalFileLinks } from './terminal-file-links.ts'
import { planScope, tabsForScope } from './scoped-tabs.ts'
import { at } from '@shared/array-utils.ts'

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
  /** Thread this shell belongs to; only the active thread's tabs are shown. */
  scopeId: string | null
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
  listHeader.append(panePopoutButton(api, 'terminal', 'terminal'), newBtn)

  const tabsWrap = el('div', { class: 'terminals-list' })
  listRoot.append(listHeader, tabsWrap)

  const body = el('div', { class: 'terminals-body' })
  viewerRoot.append(body)

  const tabs = new Map<string, TerminalTab>()
  let activeTabId: string | null = null
  let tabCounter = 0
  // Which thread's shells are currently shown. Tracked so we only re-scope when
  // the active thread actually changes (threads_changed fires for many reasons).
  let lastThreadId: string | null = store.getState().activeThreadId

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
    tab.term.writeln(`\r\n\x1b[90m[Process exited with code ${String(code)}]\x1b[0m`)
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

  function setTabLabel(tab: TerminalTab, label: string): void {
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

  async function autoNameTab(tab: TerminalTab): Promise<void> {
    if (tab.renamed || tab.autoNamed || tab.naming) return
    const text = readTerminalText(tab)
    if (text.length < 8) return
    tab.naming = true
    try {
      const title = await api.agent.suggestTerminalTitle(text)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tab.renamed can be set by a user rename during the await above
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
  function scheduleAutoName(tab: TerminalTab): void {
    if (tab.renamed || tab.autoNamed || tab.naming) return
    if (tab.nameTimer != null) clearTimeout(tab.nameTimer)
    tab.nameTimer = setTimeout(() => {
      tab.nameTimer = null
      void autoNameTab(tab)
    }, 2500)
  }

  // Replace the tab label with an inline text field for manual renaming.
  function beginRename(tab: TerminalTab): void {
    if (tab.nameTimer != null) {
      clearTimeout(tab.nameTimer)
      tab.nameTimer = null
    }
    const input = el('input', {
      type: 'text',
      class: 'terminals-tab-rename',
    })
    input.value = tab.label
    let done = false
    const finish = (save: boolean): void => {
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
    input.addEventListener('blur', () => {
      finish(true)
    })
    for (const evt of ['click', 'dblclick', 'mousedown'] as const) {
      input.addEventListener(evt, (e) => {
        e.stopPropagation()
      })
    }
    tab.labelSpan.replaceWith(input)
    input.focus()
    input.select()
  }

  function openTerminalSurface(tab: TerminalTab): void {
    if (tab.termOpened) return
    tab.term.open(tab.container)
    tab.termOpened = true
  }

  async function flushPendingInput(tab: TerminalTab): Promise<void> {
    if (!tab.sessionId) return
    let chunk = tab.pendingInput.shift()
    while (chunk !== undefined) {
      await api.terminal.write(tab.sessionId, chunk)
      chunk = tab.pendingInput.shift()
    }
  }

  async function ensureSession(tab: TerminalTab): Promise<void> {
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

  async function destroySession(tab: TerminalTab): Promise<void> {
    if (!tab.sessionId) return
    const old = tab.sessionId
    tab.sessionId = null
    await api.terminal.destroy(old)
  }

  function fitTab(tab: TerminalTab): void {
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

  function focusTab(tab: TerminalTab): void {
    openTerminalSurface(tab)
    fitTab(tab)
    tab.term.focus()
  }

  function setActiveTab(tabId: string): void {
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

  function wireTabInput(tab: TerminalTab): void {
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

  function currentThreadId(): string | null {
    return store.getState().activeThreadId
  }

  function visibleTabs(): TerminalTab[] {
    return tabsForScope(tabs.values(), currentThreadId())
  }

  function setTabVisible(tab: TerminalTab, visible: boolean): void {
    tab.tabBtn.hidden = !visible
    if (!visible) tab.panel.classList.remove('is-active')
  }

  function addTab(options?: { activate?: boolean }): string {
    tabCounter += 1
    const id = crypto.randomUUID()
    const label = `Terminal ${String(tabCounter)}`
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
    )

    const panel = el('div', { class: 'terminals-tab-panel', 'data-tab-id': id })
    const container = el('div', { class: 'terminal-container' })
    panel.append(container)

    const { term, fitAddon } = createXterm()
    const fileLinks = installTerminalFileLinks(term, store, api)
    const tab: TerminalTab = {
      id,
      scopeId: currentThreadId(),
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
      // Reclaim the viewer from any agent-task panel that was showing. Done after
      // setActiveTab so a same-tab click (which setActiveTab skips) still returns
      // to the live terminal and re-fits it once the panel is hidden.
      store.emit('shell_tab_activated')
      const tab = tabs.get(id)
      if (tab && terminalModeActive(store)) {
        requestAnimationFrame(() => {
          fitTab(tab)
          focusTab(tab)
        })
      }
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

  async function removeTab(tabId: string): Promise<void> {
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
    const remaining = visibleTabs()
    const lastRemaining = remaining[remaining.length - 1]
    if (lastRemaining !== undefined) {
      setActiveTab(lastRemaining.id)
    } else {
      activeTabId = null
      if (terminalModeActive(store)) addTab()
    }
  }

  // Thread switch: keep each thread's shells alive but only show the active
  // thread's. Sessions are spawned with the workspace cwd they were created in,
  // so a background thread's shells stay rooted in that project; switching back
  // restores them rather than showing the other thread's shells (issue #502).
  function onScopeSwitch(): void {
    const { visible, hidden, needsNew } = planScope(tabs.values(), currentThreadId())
    for (const tab of hidden) setTabVisible(tab, false)
    for (const tab of visible) setTabVisible(tab, true)

    // Drop the active highlight from any now-hidden tab.
    if (activeTabId && !visible.some((t) => t.id === activeTabId)) activeTabId = null

    if (needsNew) {
      if (terminalModeActive(store)) addTab()
      return
    }
    if (!activeTabId && visible.length > 0) setActiveTab(at(visible, 0).id)
    const tab = activeTabId ? tabs.get(activeTabId) : null
    if (tab && terminalModeActive(store)) {
      resizeObserver.observe(tab.container)
      openTerminalSurface(tab)
      void ensureSession(tab)
      requestAnimationFrame(() => {
        fitTab(tab)
        focusTab(tab)
      })
    }
  }

  const resizeObserver = new ResizeObserver(() => {
    const tab = activeTabId ? tabs.get(activeTabId) : null
    if (tab) fitTab(tab)
  })

  function onTerminalModeChange(): void {
    const active = terminalModeActive(store)
    if (active) {
      if (visibleTabs().length === 0) addTab()
      const tab = activeTabId ? tabs.get(activeTabId) : null
      if (tab) {
        resizeObserver.observe(tab.container)
        openTerminalSurface(tab)
        fitTab(tab)
        void ensureSession(tab)
        requestAnimationFrame(() => {
          focusTab(tab)
        })
      }
    } else {
      resizeObserver.disconnect()
    }
  }

  function onThemeChange(theme: 'light' | 'dark'): void {
    for (const tab of tabs.values()) {
      tab.term.options.theme = XTERM_THEME[theme]
    }
  }

  function onFontSizeChange(): void {
    const size = store.getState().fontSize
    for (const tab of tabs.values()) {
      tab.term.options.fontSize = size
    }
    const tab = activeTabId ? tabs.get(activeTabId) : null
    if (tab) fitTab(tab)
  }

  newBtn.addEventListener('click', () => addTab())

  onTerminalModeChange()

  // While an agent task panel owns the viewer, the shells list drops its active
  // highlight; when the task is cleared (taskId null), restore it.
  function onAgentTaskSelected(taskId: string | null): void {
    for (const tab of tabs.values()) {
      tab.tabBtn.classList.toggle('is-active', taskId ? false : tab.id === activeTabId)
    }
  }

  // Only re-scope when the active thread actually changed. `threads_changed`
  // fires for many unrelated reasons (streaming, renames), and `workspace_changed`
  // also swaps the active thread when the project switches — both funnel here.
  function onThreadMaybeChanged(): void {
    const threadId = currentThreadId()
    if (threadId === lastThreadId) return
    lastThreadId = threadId
    onScopeSwitch()
  }

  const unsubs = [
    store.on('right_panel_mode_changed', onTerminalModeChange),
    store.on('files_pane_changed', onTerminalModeChange),
    store.on('agent_task_selected', onAgentTaskSelected),
    store.on('theme_changed', onThemeChange),
    store.on('settings_changed', onFontSizeChange),
    store.on('threads_changed', onThreadMaybeChanged),
    store.on('workspace_changed', onThreadMaybeChanged),
  ]

  return () => {
    unsubs.forEach((u) => {
      u()
    })
    resizeObserver.disconnect()
    unsubOutput()
    unsubExit()
    void (async (): Promise<void> => {
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
