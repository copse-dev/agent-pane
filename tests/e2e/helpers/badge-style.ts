import assert from 'node:assert/strict'
import { browser } from '@wdio/globals'

/**
 * Rendered style of one badge, for the "Badges are labels" rule in
 * docs/ui-taste.md: status hues mean status, and every Settings chip shares the
 * `.ui-badge` recipe (sentence case, `--radius` corner, one size and weight).
 */
export type BadgeStyle = {
  selector: string
  text: string
  color: string
  borderColor: string
  textTransform: string
  firstLetterTransform: string
  borderRadius: string
  fontSize: string
  fontWeight: string
  fontFamily: string
}

/** Computed style of every element matching `selector`, in document order. */
export async function readBadgeStyles(selector: string): Promise<BadgeStyle[]> {
  return browser.execute((sel) => {
    return [...document.querySelectorAll<HTMLElement>(sel)].map((badge) => {
      const style = getComputedStyle(badge)
      return {
        selector: sel,
        text: badge.textContent,
        color: style.color,
        borderColor: style.borderTopColor,
        textTransform: style.textTransform,
        firstLetterTransform: getComputedStyle(badge, '::first-letter').textTransform,
        borderRadius: style.borderTopLeftRadius,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontFamily: style.fontFamily,
      }
    })
  }, selector)
}

/**
 * The status and accent tokens resolved to computed colours, so a badge can be
 * compared against them. (Keys avoid `error`: WebDriver reads a result carrying
 * that key as a failed command.)
 */
export async function signalColours(): Promise<{ token: string; value: string }[]> {
  return browser.execute(() => {
    const probe = document.createElement('span')
    document.body.append(probe)
    const out = ['--warning', '--error', '--success', '--danger', '--accent'].map((token) => {
      probe.style.color = `var(${token})`
      return { token, value: getComputedStyle(probe).color }
    })
    probe.remove()
    return out
  })
}

/** The badge's text and outline use none of the status or accent colours. */
export function assertNeutralBadge(
  badge: BadgeStyle,
  signals: { token: string; value: string }[],
): void {
  for (const { token, value } of signals) {
    assert.notEqual(badge.color, value, `"${badge.text}" text must not be ${token}`)
    assert.notEqual(badge.borderColor, value, `"${badge.text}" outline must not be ${token}`)
  }
}

/**
 * The shared badge recipe: sentence case (the first letter is capitalised, the
 * rest left as written — `literal` badges keep even the first letter), a 6px
 * `--radius` corner rather than a pill, 11px at weight 500.
 */
export function assertBadgeRecipe(badge: BadgeStyle, opts: { literal?: boolean } = {}): void {
  const label = `"${badge.text}" (${badge.selector})`
  assert.equal(badge.textTransform, 'none', `${label} is not shouted in caps`)
  assert.equal(
    badge.firstLetterTransform,
    opts.literal ? 'none' : 'uppercase',
    opts.literal ? `${label} is shown as written` : `${label} is sentence case`,
  )
  assert.equal(badge.borderRadius, '6px', `${label} takes the --radius corner, not a pill`)
  assert.equal(badge.fontSize, '11px', `${label} uses --badge-font-size`)
  assert.equal(badge.fontWeight, '500', `${label} uses --badge-font-weight`)
}
