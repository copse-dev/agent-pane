import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'

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

export function mountTerminalPanel(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const container = el('div', { class: 'terminal-container' })
  root.append(container)

  const term = new Terminal({
    cursorBlink: true,
    fontSize: store.getState().fontSize,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: XTERM_THEME[store.getState().theme],
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(container)

  let sessionId: string | null = null
  let creating = false

  const unsubOutput = api.terminal.onOutput((id, data) => {
    if (id === sessionId) term.write(data)
  })

  const unsubExit = api.terminal.onExit((id, code) => {
    if (id !== sessionId) return
    term.writeln(`\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m`)
    sessionId = null
  })

  async function ensureSession() {
    if (sessionId || creating) return
    if (!store.getState().workspaceRoot) {
      term.writeln('\x1b[90mOpen a folder to use the terminal.\x1b[0m')
      return
    }
    creating = true
    try {
      sessionId = await api.terminal.create()
    } catch (err) {
      term.writeln(`\x1b[31mFailed to start terminal: ${String(err)}\x1b[0m`)
    } finally {
      creating = false
    }
  }

  async function restartSession() {
    if (sessionId) {
      const old = sessionId
      sessionId = null
      await api.terminal.destroy(old)
    }
    term.clear()
    await ensureSession()
  }

  function fitTerminal() {
    if (root.hidden) return
    try {
      fitAddon.fit()
    } catch {
      // FitAddon throws when the container has zero dimensions.
    }
  }

  term.onData((data) => {
    if (!sessionId) {
      void ensureSession().then(() => {
        if (sessionId) void api.terminal.write(sessionId, data)
      })
      return
    }
    void api.terminal.write(sessionId, data)
  })

  const resizeObserver = new ResizeObserver(() => fitTerminal())

  function onModeChange() {
    const isTerminal = store.getState().rightPanelMode === 'terminal'
    root.hidden = !isTerminal
    if (isTerminal && store.getState().filesPaneOpen) {
      fitTerminal()
      resizeObserver.observe(container)
      void ensureSession()
    } else {
      resizeObserver.unobserve(container)
    }
  }

  function onThemeChange(theme: 'light' | 'dark') {
    term.options.theme = XTERM_THEME[theme]
  }

  function onFontSizeChange() {
    term.options.fontSize = store.getState().fontSize
    fitTerminal()
  }

  function onWorkspaceChange() {
    if (store.getState().rightPanelMode === 'terminal') void restartSession()
  }

  onModeChange()
  fitTerminal()

  const unsubs = [
    store.on('right_panel_mode_changed', onModeChange),
    store.on('files_pane_changed', onModeChange),
    store.on('theme_changed', onThemeChange),
    store.on('workspace_changed', onWorkspaceChange),
    store.on('settings_changed', onFontSizeChange),
  ]

  return () => {
    unsubs.forEach((u) => u())
    resizeObserver.disconnect()
    unsubOutput()
    unsubExit()
    if (sessionId) void api.terminal.destroy(sessionId)
    term.dispose()
  }
}
