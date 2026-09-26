import { el } from './helpers.ts'
import { chevronDownIcon } from './icons.ts'

/**
 * The `<summary>` of an in-form disclosure ("Connection options", "Advanced
 * routes"): the label, then the outline chevron that turns when the fold opens.
 * Same recipe as the plugin card's "Plugin settings" fold (settings.css), so no
 * disclosure in Settings falls back to the UA's filled ▶ triangle.
 */
export function disclosureSummary(label: string): HTMLElement {
  return el(
    'summary',
    { class: 'settings-disclosure-summary' },
    el('span', {}, label),
    // `ui-icon` carries `fill: none; stroke: currentColor`; without it the path
    // renders as a solid triangle (see the plugin fold in settings-dialog.ts).
    chevronDownIcon('ui-icon settings-disclosure-chevron'),
  )
}
