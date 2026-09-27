import { browser } from '@wdio/globals'

export interface ComposerBannerMetrics {
  padding: string
  fontSize: string
  actions: { label: string; padding: string; fontSize: string; radius: string; edge: string }[]
  /** What a tone's action border resolves to inside this banner. */
  edges: { warning: string; danger: string; neutral: string }
}

/**
 * The rendered box of a composer advisory strip and each visible action in it.
 *
 * Every strip shares one `.composer-banner-action` recipe, with the strip's tone
 * (warning or danger) colouring the border. The expected edges are resolved by
 * a probe inside the banner, so they go through the same theme and color-mix
 * the real buttons do.
 */
export async function composerBannerMetrics(
  selector: string,
): Promise<ComposerBannerMetrics | null> {
  return browser.execute((target: string) => {
    const banner = document.querySelector(target)
    if (!(banner instanceof HTMLElement)) return null
    const edge = (colour: string): string => {
      const probe = document.createElement('span')
      probe.style.cssText = `position:absolute;visibility:hidden;border:1px solid ${colour}`
      banner.append(probe)
      const resolved = getComputedStyle(probe).borderTopColor
      probe.remove()
      return resolved
    }
    const style = getComputedStyle(banner)
    return {
      padding: style.padding,
      fontSize: style.fontSize,
      actions: [...banner.querySelectorAll<HTMLElement>('.composer-banner-action')]
        .filter((action) => action.getClientRects().length > 0)
        .map((action) => {
          const own = getComputedStyle(action)
          return {
            label: action.textContent ?? '',
            padding: own.padding,
            fontSize: own.fontSize,
            radius: own.borderTopLeftRadius,
            edge: own.borderTopColor,
          }
        }),
      edges: {
        warning: edge('color-mix(in srgb, var(--warning) 60%, var(--border))'),
        danger: edge('color-mix(in srgb, var(--danger) 60%, var(--border))'),
        neutral: edge('var(--border)'),
      },
    }
  }, selector)
}
