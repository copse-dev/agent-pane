import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'
import { seedSyntaxContrastFixture } from './light-syntax-contrast-fixture.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')

/** WCAG 2.2 AA for body text. Code spans are small text, so this is the bar. */
const AA_BODY_TEXT = 4.5

/**
 * Real, tokenised proof for issue #2486 — a JSON block (attr/string/number/
 * literal) and a TypeScript block (comment/keyword/title/type) rendered
 * through the actual message pipeline (composer → streaming-markdown →
 * highlight.js), not injected markup. `light-contrast.test.ts` proves the
 * *declared* palette clears AA; `light-contrast-surfaces.demo.ts` proves it in
 * a browser cascade. This spec is the same proof inside the shipped Electron
 * app, which is what a reviewer actually sees.
 */
async function measureHljsContrast(): Promise<{
  background: string
  backgroundLuminance: number
  tokens: { token: string; color: string; contrast: number }[]
} | null> {
  return browser.execute(() => {
    const channels = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).map(Number)
    const luminance = (rgb: number[]): number => {
      const linear = rgb.slice(0, 3).map((channel) => {
        // `color(srgb …)` reports 0-1 while `rgb()` reports 0-255.
        const scaled = channel > 1 ? channel / 255 : channel
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
    }
    const contrast = (a: string, b: string): number => {
      const [x, y] = [luminance(channels(a)), luminance(channels(b))]
      const [high, low] = x! > y! ? [x!, y!] : [y!, x!]
      return (high + 0.05) / (low + 0.05)
    }
    const blocks = [...document.querySelectorAll('.streaming-markdown pre')]
    const first = blocks[0]
    if (!first) return null
    const background = getComputedStyle(first).backgroundColor
    const tokens = new Map<string, { color: string; contrast: number }>()
    for (const element of blocks.flatMap((block) => [
      ...block.querySelectorAll('[class*="hljs-"]'),
    ])) {
      for (const name of element.classList) {
        if (!name.startsWith('hljs-') || tokens.has(name)) continue
        const color = getComputedStyle(element).color
        tokens.set(name, { color, contrast: contrast(color, background) })
      }
    }
    return {
      background,
      backgroundLuminance: luminance(channels(background)),
      tokens: [...tokens].map(([token, measure]) => ({ token, ...measure })),
    }
  })
}

describe('syntax highlighting contrast in the shipped app (#2486)', () => {
  after(() => {
    resetUserData()
  })

  it('keeps every JSON/TypeScript token readable on the light code surface', async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    seedSyntaxContrastFixture(process.cwd(), 'light')
    await browser.reloadSession()

    await $('[data-message-id="msg-assistant-syntax-contrast"] code.hljs').waitForDisplayed({
      timeout: 30_000,
    })

    const measured = await measureHljsContrast()
    assert.ok(measured, 'the scenario must render a fenced code block')
    // Guards the guard: a dark ground here would mean the light theme never applied.
    assert.ok(
      measured.backgroundLuminance > 0.5,
      `expected a light code surface, got ${measured.background}`,
    )
    assert.ok(
      measured.tokens.length >= 8,
      `expected highlight.js to tokenise the blocks, saw ${String(measured.tokens.length)} classes`,
    )

    const unreadable = measured.tokens
      .filter((entry) => entry.contrast < AA_BODY_TEXT)
      .map((entry) => `${entry.token} ${entry.color} at ${entry.contrast.toFixed(2)}:1`)
    assert.deepEqual(
      unreadable,
      [],
      `these tokens fall below ${String(AA_BODY_TEXT)}:1 on ${measured.background}:\n${unreadable.join('\n')}`,
    )

    // The two the issue named by appearance — "light-blue keys and salmon
    // values" — are `.hljs-attr` (JSON keys) and `.hljs-string` (JSON/TS
    // string values) carrying the vendored Dark+ #9cdcfe / #ce9178.
    const attr = measured.tokens.find((entry) => entry.token === 'hljs-attr')
    const string = measured.tokens.find((entry) => entry.token === 'hljs-string')
    assert.ok(attr && string, 'the JSON block must produce attr and string tokens')
    assert.notEqual(attr.color, 'rgb(156, 220, 254)', 'JSON keys are still Dark+ #9cdcfe')
    assert.notEqual(string.color, 'rgb(206, 145, 120)', 'strings are still Dark+ #ce9178')

    await expect($('[data-message-id="msg-assistant-syntax-contrast"] .hljs-attr')).toExist()
    await expect($('[data-message-id="msg-assistant-syntax-contrast"] .hljs-keyword')).toExist()

    await saveElementScreenshot(
      '[data-message-id="msg-assistant-syntax-contrast"] .message-text',
      'light-syntax-contrast-json-ts.png',
    )
  })

  it('renders the same tokens on the dark surface for reference', async () => {
    seedSyntaxContrastFixture(process.cwd(), 'dark')
    await browser.reloadSession()

    await $('[data-message-id="msg-assistant-syntax-contrast"] code.hljs').waitForDisplayed({
      timeout: 30_000,
    })

    const measured = await measureHljsContrast()
    assert.ok(measured, 'the scenario must render a fenced code block')
    assert.ok(
      measured.backgroundLuminance < 0.5,
      `expected a dark code surface, got ${measured.background}`,
    )

    await saveElementScreenshot(
      '[data-message-id="msg-assistant-syntax-contrast"] .message-text',
      'dark-syntax-contrast-json-ts.png',
    )
  })
})
