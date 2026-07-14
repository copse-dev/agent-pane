import { el, clear } from '../dom/helpers.ts'

// The "Keyboard Shortcuts" help overlay (Cmd/Ctrl+/ or Help ▸ Keyboard
// Shortcuts). A native <dialog> (showModal) so we inherit the top-layer focus
// trap, inert background, and Esc-to-close for free — mirrors the file-search
// and settings dialogs. Content is a static cheat-sheet of the app's real
// bindings; keep it in sync with app-menu.ts, keyboard-shortcuts.ts, and the
// keydown handler in main.ts, which own the actual accelerators.

// A key token is either a modifier rendered per-platform — `Mod` (Cmd on macOS,
// Ctrl elsewhere, matching Electron's `CmdOrCtrl`), `Shift`, or `Alt` — or a
// literal key (`N`, `/`, `←`, …) shown verbatim. See keyLabel for the mapping.
type KeyToken = string

interface Shortcut {
  label: string
  keys: KeyToken[]
}

interface ShortcutSection {
  title: string
  shortcuts: Shortcut[]
}

// happy-dom reports an empty navigator.platform, so fall back to userAgent.
function isMacPlatform(): boolean {
  const platform = navigator.platform || navigator.userAgent || ''
  return /mac/i.test(platform)
}

function keyLabel(token: KeyToken, isMac: boolean): string {
  switch (token) {
    case 'Mod':
      return isMac ? '⌘' : 'Ctrl'
    case 'Shift':
      return isMac ? '⇧' : 'Shift'
    case 'Alt':
      return isMac ? '⌥' : 'Alt'
    default:
      return token
  }
}

// Mirrors the bindings wired in app-menu.ts / keyboard-shortcuts.ts / main.ts.
const SECTIONS: ShortcutSection[] = [
  {
    title: 'General',
    shortcuts: [
      { label: 'New thread', keys: ['Mod', 'N'] },
      { label: 'Open folder…', keys: ['Mod', 'O'] },
      { label: 'Settings', keys: ['Mod', ','] },
      { label: 'Keyboard shortcuts', keys: ['Mod', '/'] },
      { label: 'Stop agent / close overlay', keys: ['Esc'] },
    ],
  },
  {
    title: 'Navigation',
    shortcuts: [
      { label: 'Quick open file', keys: ['Mod', 'P'] },
      { label: 'Find in conversation', keys: ['Mod', 'F'] },
      { label: 'Previous thread', keys: ['Alt', '←'] },
      { label: 'Next thread', keys: ['Alt', '→'] },
      { label: 'Close thread', keys: ['Mod', 'W'] },
    ],
  },
  {
    title: 'Panels',
    shortcuts: [
      { label: 'Toggle side panel', keys: ['Mod', 'B'] },
      { label: 'Explorer', keys: ['Mod', 'Shift', 'E'] },
      { label: 'Terminal', keys: ['Mod', '`'] },
      { label: 'Changes', keys: ['Mod', 'Shift', 'G'] },
      { label: 'Browser', keys: ['Mod', 'Shift', 'B'] },
    ],
  },
]

let dialogEl: HTMLDialogElement | null = null

export function openKeyboardShortcutsDialog(): void {
  if (!dialogEl || dialogEl.open) return
  dialogEl.showModal()
}

export function closeKeyboardShortcutsDialog(): void {
  if (dialogEl?.open) dialogEl.close()
}

export function isKeyboardShortcutsDialogOpen(): boolean {
  return !!dialogEl?.open
}

export function mountKeyboardShortcutsDialog(): void {
  const dialog = document.createElement('dialog')
  dialog.id = 'keyboard-shortcuts-dialog'
  dialog.className = 'keyboard-shortcuts-overlay'

  const isMac = isMacPlatform()

  const grid = el('div', { class: 'keyboard-shortcuts-grid' })
  for (const section of SECTIONS) {
    const group = el('div', { class: 'keyboard-shortcuts-group' })
    group.append(el('h4', { class: 'keyboard-shortcuts-group-title' }, section.title))
    for (const shortcut of section.shortcuts) {
      const keys = el('span', { class: 'keyboard-shortcuts-keys' })
      shortcut.keys.forEach((token) => {
        keys.append(el('kbd', { class: 'keyboard-shortcuts-key' }, keyLabel(token, isMac)))
      })
      group.append(
        el(
          'div',
          { class: 'keyboard-shortcuts-row' },
          el('span', { class: 'keyboard-shortcuts-label' }, shortcut.label),
          keys,
        ),
      )
    }
    grid.append(group)
  }

  const shell = el(
    'div',
    { class: 'keyboard-shortcuts-shell' },
    el('h3', { class: 'keyboard-shortcuts-title' }, 'Keyboard Shortcuts'),
    grid,
  )
  clear(dialog)
  dialog.append(shell)
  document.body.append(dialog)
  dialogEl = dialog

  // Clicking the backdrop (the dialog element itself, outside the shell) closes,
  // matching the file-search palette.
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) closeKeyboardShortcutsDialog()
  })
}
