import type * as Monaco from 'monaco-editor'
import type { ITheme } from '@xterm/xterm'
import type { Theme } from '@shared/types/state.ts'

/**
 * The terminal (xterm) and the editors (Monaco) paint their own canvases from a
 * JS theme object, so they cannot follow the CSS tokens by cascade the way the
 * rest of the workbench does. They used to hard-code VS Code's greys, which left
 * a grey slab in a teal pane under Strong + the Copse tint (#3065). This module
 * resolves the tokens once, maps them to both libraries' theme shapes, and
 * re-resolves whenever the appearance on `<html>` changes.
 */

/** Resolved `#rrggbb` colours the editor surfaces are built from. */
export interface EditorThemeTokens {
  scheme: Theme
  /** `--bg-base`: the pane surface the terminal and editors sit on. */
  background: string
  /** `--bg-elevated`: floating editor widgets (find, hover, suggest). */
  elevated: string
  /** `--text-primary` */
  foreground: string
  /** `--border` */
  border: string
  /** `--border-subtle` */
  borderSubtle: string
  /** `--selection-bg` */
  selectionBackground: string
  /** `--selection-text` */
  selectionForeground: string
}

type TokenField = Exclude<keyof EditorThemeTokens, 'scheme'>

/** Which CSS custom property each field resolves from. */
export const EDITOR_THEME_TOKEN_PROPERTIES: Readonly<Record<TokenField, string>> = {
  background: '--bg-base',
  elevated: '--bg-elevated',
  foreground: '--text-primary',
  border: '--border',
  borderSubtle: '--border-subtle',
  selectionBackground: '--selection-bg',
  selectionForeground: '--selection-text',
}

/** The untinted token values, used for any token that fails to resolve. */
export const FALLBACK_EDITOR_THEME_TOKENS: Readonly<Record<Theme, EditorThemeTokens>> = {
  dark: {
    scheme: 'dark',
    background: '#1e1e1e',
    elevated: '#252526',
    foreground: '#d4d4d4',
    border: '#414141',
    borderSubtle: '#333333',
    selectionBackground: '#2f6fd0',
    selectionForeground: '#ffffff',
  },
  light: {
    scheme: 'light',
    background: '#ffffff',
    elevated: '#f3f3f3',
    foreground: '#333333',
    border: '#d4d4d4',
    borderSubtle: '#e4e4e4',
    selectionBackground: '#b0d3ff',
    selectionForeground: '#10243b',
  },
}

/** Name the Monaco theme is registered under; every editor is created with it. */
export const COPSE_MONACO_THEME = 'copse'

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTION_PATTERN = /^(rgba?|color)\(\s*(.*?)\s*\)$/i

function hexByte(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0')
}

function isOpaque(alpha: string | undefined): boolean {
  if (alpha === undefined) return true
  const trimmed = alpha.trim()
  const value = trimmed.endsWith('%')
    ? Number.parseFloat(trimmed) / 100
    : Number.parseFloat(trimmed)
  return value >= 1
}

/**
 * Normalise an opaque computed CSS colour to `#rrggbb`, or null when it is not
 * one. Chromium serialises a resolved `color-mix(in srgb, …)` either as legacy
 * `rgb()` or as `color(srgb r g b)` depending on platform, and both editors only
 * accept hex, so all three forms are handled. A translucent colour is rejected:
 * neither library composites a theme colour over what sits behind the canvas.
 */
export function cssColorToHex(value: string): string | null {
  const text = value.trim().toLowerCase()
  const hex = HEX_PATTERN.exec(text)?.[1]
  if (hex !== undefined) {
    if (hex.length === 3) return `#${hex.replace(/(.)/g, '$1$1')}`
    if (hex.length === 8 && !hex.endsWith('ff')) return null
    return `#${hex.slice(0, 6)}`
  }
  const match = FUNCTION_PATTERN.exec(text)
  const name = match?.[1]
  const args = match?.[2]
  if (name === undefined || args === undefined) return null
  const [channelText, alphaText, extra] = args.split('/')
  if (extra !== undefined || !isOpaque(alphaText)) return null
  const parts = (channelText ?? '').split(/[\s,]+/).filter((part) => part.length > 0)
  let channels: string[]
  let scale: number
  if (name === 'color') {
    if (parts[0] !== 'srgb') return null
    channels = parts.slice(1)
    scale = 255
  } else {
    // Legacy comma syntax carries alpha as a fourth list item.
    if (parts.length === 4 && isOpaque(parts[3])) parts.length = 3
    channels = parts
    scale = 1
  }
  if (channels.length !== 3) return null
  const bytes = channels.map((channel) =>
    channel.endsWith('%')
      ? (Number.parseFloat(channel) / 100) * 255
      : Number.parseFloat(channel) * scale,
  )
  if (bytes.some((byte) => !Number.isFinite(byte))) return null
  return `#${bytes.map(hexByte).join('')}`
}

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

/** `weight` of `a` mixed into `b`, in sRGB — `color-mix(in srgb, a weight, b)`. */
export function mixHex(a: string, b: string, weight: number): string {
  const from = channels(a)
  const to = channels(b)
  return `#${from.map((channel, index) => hexByte(channel * weight + (to[index] ?? 0) * (1 - weight))).join('')}`
}

/**
 * Share of the focused selection fill kept in the unfocused one. xterm's own
 * default inactive colour is a fixed dark grey that swallowed light-theme text,
 * so it is derived per theme: one step quieter than the focused fill, still
 * carrying `--selection-text` (see "Every highlight declares both halves" in
 * docs/ui-taste.md).
 */
const INACTIVE_SELECTION_WEIGHT = 0.6

export function xtermThemeFromTokens(tokens: EditorThemeTokens): ITheme {
  return {
    background: tokens.background,
    foreground: tokens.foreground,
    cursor: tokens.foreground,
    cursorAccent: tokens.background,
    selectionBackground: tokens.selectionBackground,
    selectionForeground: tokens.selectionForeground,
    selectionInactiveBackground: mixHex(
      tokens.selectionBackground,
      tokens.background,
      INACTIVE_SELECTION_WEIGHT,
    ),
  }
}

/**
 * Monaco theme data layered over the stock `vs` / `vs-dark` theme. Only the
 * surfaces move onto tokens; syntax colours and the selection wash stay the
 * base theme's. Monaco paints syntax colours over its selection and has no
 * selection foreground outside high-contrast themes, so the app's opaque
 * `--selection-bg` (paired with `--selection-text`) would bury token colours.
 */
export function monacoThemeFromTokens(
  tokens: EditorThemeTokens,
): Monaco.editor.IStandaloneThemeData {
  return {
    base: tokens.scheme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': tokens.background,
      'editor.foreground': tokens.foreground,
      'editor.lineHighlightBorder': tokens.borderSubtle,
      'editorWidget.background': tokens.elevated,
      'editorWidget.border': tokens.border,
      'diffEditor.unchangedRegionBackground': tokens.elevated,
    },
  }
}

/** Resolve the editor tokens from the live cascade on `<html>`. */
export function readEditorThemeTokens(
  root: HTMLElement = document.documentElement,
): EditorThemeTokens {
  const scheme: Theme = root.dataset['theme'] === 'light' ? 'light' : 'dark'
  const fallback = FALLBACK_EDITOR_THEME_TOKENS[scheme]
  // Custom properties compute to their unresolved text (`color-mix(…)`), so
  // route each one through a real `color` declaration to get a colour value.
  const view = root.ownerDocument.defaultView
  const probe = root.ownerDocument.createElement('span')
  probe.hidden = true
  root.append(probe)
  const resolve = (field: TokenField): string => {
    probe.style.color = `var(${EDITOR_THEME_TOKEN_PROPERTIES[field]})`
    return cssColorToHex(view?.getComputedStyle(probe).color ?? '') ?? fallback[field]
  }
  const tokens: EditorThemeTokens = {
    scheme,
    background: resolve('background'),
    elevated: resolve('elevated'),
    foreground: resolve('foreground'),
    border: resolve('border'),
    borderSubtle: resolve('borderSubtle'),
    selectionBackground: resolve('selectionBackground'),
    selectionForeground: resolve('selectionForeground'),
  }
  probe.remove()
  return tokens
}

/** Every resolved field, in declaration order. */
export const EDITOR_THEME_TOKEN_FIELDS: readonly TokenField[] = [
  'background',
  'elevated',
  'foreground',
  'border',
  'borderSubtle',
  'selectionBackground',
  'selectionForeground',
]

function sameTokens(a: EditorThemeTokens, b: EditorThemeTokens): boolean {
  return a.scheme === b.scheme && EDITOR_THEME_TOKEN_FIELDS.every((field) => a[field] === b[field])
}

/**
 * Call `onChange` with freshly resolved tokens whenever the appearance on
 * `<html>` changes. Theme (`data-theme`), tint (`data-tint-*`, `--tint-*`) and
 * accent (`--accent-color`) are all written there — by Settings previews, Save,
 * Cancel and the OS theme watcher — and not all of those paths emit
 * `theme_changed` (or emit it before the attribute lands), so the root element
 * itself is the one reliable signal. Unrelated inline-style writes (e.g.
 * `--ui-scale`) resolve to the same tokens and are dropped.
 */
export function watchEditorTheme(
  onChange: (tokens: EditorThemeTokens) => void,
  root: HTMLElement = document.documentElement,
): () => void {
  let current = readEditorThemeTokens(root)
  const observer = new MutationObserver(() => {
    const next = readEditorThemeTokens(root)
    if (sameTokens(current, next)) return
    current = next
    onChange(next)
  })
  observer.observe(root, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-tint-palette', 'data-tint-strength', 'style'],
  })
  return () => {
    observer.disconnect()
  }
}

/** The slice of the Monaco namespace the theme needs. */
export interface MonacoThemeApi {
  editor: {
    defineTheme(name: string, data: Monaco.editor.IStandaloneThemeData): void
    setTheme(name: string): void
  }
}

/**
 * Register {@link COPSE_MONACO_THEME} from the current tokens and keep it in
 * step with appearance changes. Monaco themes are global to the window, so this
 * runs once when the Monaco bundle loads rather than per editor.
 */
export function installMonacoEditorTheme(monaco: MonacoThemeApi): () => void {
  const apply = (tokens: EditorThemeTokens): void => {
    monaco.editor.defineTheme(COPSE_MONACO_THEME, monacoThemeFromTokens(tokens))
    monaco.editor.setTheme(COPSE_MONACO_THEME)
  }
  apply(readEditorThemeTokens())
  return watchEditorTheme(apply)
}
