import { browser } from '@wdio/globals'

/** WCAG 2.2 AA for body text. The labels measured here are small UI text. */
export const AA_BODY_TEXT = 4.5

export interface FillContrast {
  /** WCAG ratio between the label and the fill it sits on, as painted. */
  ratio: number
  /** The resolved sRGB label and fill, for the failure message. */
  label: string
  fill: string
}

/**
 * Contrast between an element's label colour and its own fill, the way the
 * compositor paints it rather than the way the token names read.
 *
 * Colours resolve through a 1×1 canvas, so `color-mix()` and `color(srgb …)`
 * computed values land in plain sRGB. A translucent fill is composited over the
 * nearest opaque ancestor, an ancestor's `opacity` fades both toward what is
 * behind it, and `filter: brightness(n)` (the queued chips' hover) scales both
 * label and fill, which is what the filter does to every pixel.
 */
export async function fillContrast(selector: string): Promise<FillContrast | null> {
  return browser.execute((target: string) => {
    const element = document.querySelector(target)
    if (!(element instanceof HTMLElement)) return null
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const rgba = (colour: string): number[] => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = colour
      ctx.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const over = (top: number[], bottom: number[]): number[] => {
      const alpha = top[3] ?? 1
      return [0, 1, 2].map((i) => (top[i] ?? 0) * alpha + (bottom[i] ?? 0) * (1 - alpha))
    }
    const backdrop = (from: HTMLElement | null): number[] => {
      for (let node = from; node; node = node.parentElement) {
        const colour = rgba(getComputedStyle(node).backgroundColor)
        if ((colour[3] ?? 0) >= 1) return colour
      }
      return [0, 0, 0, 1]
    }
    const style = getComputedStyle(element)
    const brightness = Number.parseFloat(/brightness\(([\d.]+)\)/.exec(style.filter)?.[1] ?? '1')
    const lift = (rgb: number[]): number[] =>
      rgb.slice(0, 3).map((channel) => Math.min(255, Math.round(channel * brightness)))
    // A dimmed ancestor (a queued message's body sits at 0.85) fades label and
    // fill alike toward whatever is painted behind the dimmed group.
    let opacity = 1
    let outermostDimmed: HTMLElement | null = null
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const own = Number.parseFloat(getComputedStyle(node).opacity)
      if (own < 1) {
        opacity *= own
        outermostDimmed = node
      }
    }
    const behindGroup = backdrop(outermostDimmed?.parentElement ?? element.parentElement)
    const fade = (rgb: number[]): number[] => over([...rgb.slice(0, 3), opacity], behindGroup)
    const solidFill = over(rgba(style.backgroundColor), backdrop(element.parentElement))
    const fill = lift(fade(solidFill))
    const label = lift(fade(over(rgba(style.color), solidFill)))
    const luminance = (rgb: number[]): number => {
      const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
        const c = channel / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const [high = 0, low = 0] = [luminance(label), luminance(fill)].sort((x, y) => y - x)
    return {
      ratio: Number(((high + 0.05) / (low + 0.05)).toFixed(2)),
      label: `rgb(${label.join(', ')})`,
      fill: `rgb(${fill.join(', ')})`,
    }
  }, selector)
}
