import { mountAnnotationLayer } from '../../../src/renderer/drawing/annotation-layer.ts'

// Mounts the real annotation layer over stand-in panes at the widths its tool
// strip has to survive, from a roomy pane down to one that only holds the
// narrowest layout. Each pane is a host exactly as the Browser pane, an inline
// canvas stage or the image viewer provides one: a positioned box the layer
// fills. The spec reads the strip each pane ends up with.

const fixture = document.querySelector<HTMLElement>('#fixture')
if (!fixture) throw new Error('Missing fixture mount')

/** Pane widths in CSS pixels, one per layout the strip steps through. */
const PANES: readonly { width: number; actionLabel?: string }[] = [
  { width: 560 },
  { width: 404 },
  { width: 340 },
  // A Browser or Desktop pane beside the chat and a tab rail in a 1200px window.
  { width: 279 },
  { width: 340, actionLabel: 'Update' },
]

for (const [index, pane] of PANES.entries()) {
  const caption = document.createElement('div')
  caption.textContent = `${String(pane.width)}px pane${pane.actionLabel ? `, "${pane.actionLabel}" action` : ''}`
  caption.style.cssText =
    'margin:0 0 4px;color:var(--text-muted);font-size:var(--font-size-xs);line-height:14px'

  const host = document.createElement('div')
  host.className = 'annotation-fixture-pane'
  host.dataset['pane'] = String(index)
  host.style.cssText = `position:relative;width:${String(pane.width)}px;height:92px;margin:0 0 10px;background:var(--browser-page-background);border-radius:var(--radius);overflow:hidden`

  fixture.append(caption, host)
  const layer = mountAnnotationLayer(host, {
    label: `${String(pane.width)}px pane`,
    onSend: () => true,
    ...(pane.actionLabel ? { actionLabel: pane.actionLabel } : {}),
  })
  layer.activate()
}
