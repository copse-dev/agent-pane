import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { browser } from '@wdio/globals'
import type { RuleCounts } from '../../../scripts/lib/a11y-baseline.mts'

/**
 * WCAG 2.0/2.1/2.2 level A and AA: the conformance target docs/accessibility.md
 * names. Best-practice rules stay out so the baseline tracks the standard.
 */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

let axeSource: string | null = null

function readAxeSource(): string {
  axeSource ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
  return axeSource
}

export interface AxeViolationNode {
  rule: string
  impact: string
  help: string
  target: string
}

export interface AxeScan {
  counts: RuleCounts
  nodes: AxeViolationNode[]
}

/**
 * Run axe-core in the live renderer against `root` (a CSS selector). The
 * library is injected on demand, so a reload or reloadSession is harmless.
 * Pass `exclude` for regions another surface already owns.
 */
export async function scanAccessibility(
  root: string,
  exclude: readonly string[] = [],
): Promise<AxeScan> {
  const loaded = await browser.execute(() => typeof window.axe?.run === 'function')
  if (!loaded) await browser.execute(`${readAxeSource()}\n;return true`)
  const result = await browser.execute(
    async (selector, excluded, tags) => {
      const axe = window.axe
      if (!axe) throw new Error('axe-core failed to load in the renderer')
      if (!document.querySelector(selector)) throw new Error(`No element matches ${selector}`)
      const results = await axe.run(
        { include: [selector], exclude: excluded },
        { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] },
      )
      return results.violations.flatMap((violation) =>
        violation.nodes.map((node) => ({
          rule: violation.id,
          impact: violation.impact ?? 'unknown',
          help: violation.help,
          target: node.target.map(String).join(' >>> '),
        })),
      )
    },
    root,
    [...exclude],
    WCAG_TAGS,
  )
  const counts: Record<string, number> = {}
  for (const node of result) counts[node.rule] = (counts[node.rule] ?? 0) + 1
  return { counts, nodes: result }
}
