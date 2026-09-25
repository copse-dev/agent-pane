import { browser } from '@wdio/globals'

/** The computed type treatment of one heading, as the heading tiers in docs/ui-taste.md read it. */
export type HeadingStyle = {
  tag: string
  family: string
  weight: string
  /** Used font size in px. */
  size: number
}

/**
 * Computed style of the first element matching `selector`, or null when it is
 * not in the DOM. `h1`–`h3` are the display tier (Averia at weight 400); utility
 * headings and nested card titles stay in the interface face.
 */
export async function readHeadingStyle(selector: string): Promise<HeadingStyle | null> {
  return browser.execute((target) => {
    const node = document.querySelector(target)
    if (!node) return null
    const style = getComputedStyle(node)
    return {
      tag: node.tagName,
      family: style.fontFamily,
      weight: style.fontWeight,
      size: Number.parseFloat(style.fontSize),
    }
  }, selector)
}

/** True when a computed `font-family` resolves to the display face. */
export function isDisplayFace(family: string): boolean {
  return /averia/i.test(family)
}
