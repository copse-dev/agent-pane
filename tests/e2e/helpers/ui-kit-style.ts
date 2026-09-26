import assert from 'node:assert/strict'
import { browser } from '@wdio/globals'

interface ButtonChrome {
  found: boolean
  classes: string
  hasBorder: boolean
  hasFill: boolean
  whiteSpace: string
  borderTopColor: string
  backgroundColor: string
}

/**
 * Computed chrome of the first element matching `selector`: whether it paints a
 * visible border or fill. The global `button` reset strips both, so a button
 * that carries only an unstyled class renders as a bare word — this is how the
 * specs prove a control reads as a button, not how it happens to be classed.
 */
async function buttonChrome(selector: string): Promise<ButtonChrome> {
  return browser.execute((sel) => {
    const node = document.querySelector(sel)
    const transparent = (color: string): boolean =>
      color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color.replace(/\s+/g, ' '))
    if (!(node instanceof HTMLElement)) {
      return {
        found: false,
        classes: '',
        hasBorder: false,
        hasFill: false,
        whiteSpace: '',
        borderTopColor: '',
        backgroundColor: '',
      }
    }
    const style = getComputedStyle(node)
    return {
      found: true,
      classes: node.className,
      hasBorder:
        Number.parseFloat(style.borderTopWidth) >= 1 &&
        style.borderTopStyle !== 'none' &&
        !transparent(style.borderTopColor),
      hasFill: !transparent(style.backgroundColor),
      whiteSpace: style.whiteSpace,
      borderTopColor: style.borderTopColor,
      backgroundColor: style.backgroundColor,
    }
  }, selector)
}

/** Assert the element is a UI-kit button that paints a border or a fill. */
export async function assertKitButtonChrome(
  selector: string,
  variant: 'primary' | 'secondary' | 'danger',
): Promise<void> {
  const chrome = await buttonChrome(selector)
  assert.ok(chrome.found, `${selector} must exist`)
  assert.match(chrome.classes, /\bui-btn\b/, `${selector} must use the UI kit`)
  assert.match(chrome.classes, new RegExp(`\\bui-btn-${variant}\\b`), `${selector} ${variant}`)
  assert.equal(chrome.whiteSpace, 'nowrap', `${selector} label must not wrap`)
  if (variant === 'secondary') {
    assert.ok(chrome.hasBorder, `${selector} must paint a border (got ${chrome.borderTopColor})`)
  } else {
    assert.ok(chrome.hasFill, `${selector} must paint a fill (got ${chrome.backgroundColor})`)
  }
}

/**
 * Computed text colour of `selector` next to the resolved `--error` token, both
 * read in that element's own cascade so a theme or scope override counts.
 * (The result deliberately has no `error` key: WebDriver reads a script result
 * carrying one as a failed command.)
 */
async function statusColorVsErrorToken(
  selector: string,
): Promise<{ found: boolean; color: string; errorToken: string }> {
  return browser.execute((sel) => {
    const node = document.querySelector(sel)
    if (!(node instanceof HTMLElement)) return { found: false, color: '', errorToken: '' }
    const probe = document.createElement('span')
    probe.style.color = 'var(--error)'
    node.append(probe)
    const errorToken = getComputedStyle(probe).color
    probe.remove()
    return { found: true, color: getComputedStyle(node).color, errorToken }
  }, selector)
}

/** Assert the element's text computes to the theme's `--error` colour. */
export async function assertErrorColor(selector: string): Promise<void> {
  const { found, color, errorToken } = await statusColorVsErrorToken(selector)
  assert.ok(found, `${selector} must exist`)
  assert.equal(color, errorToken, `${selector} must render in --error`)
}
