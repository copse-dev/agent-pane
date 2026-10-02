import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

/** Parse copied scripts and nested function bodies without executing any artwork. */
export function assertExplainerSyntax(
  template: string,
  runtime: string,
  drawings: ReadonlyArray<{ name: string; code: string }> = [],
): void {
  const html = template.replace('__COPSE_EXPLAINER_DRAWING_RUNTIME__', () => runtime)
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/type=["']application\/json["']/i.test(match[1] ?? ''))
    .map((match) => match[2] ?? '')
  if (scripts.length === 0) throw new Error('The explainer player has no executable scripts.')
  transformSync(scripts.join('\n;\n'), {
    loader: 'js',
    sourcefile: 'assets/explainers/player.html (including drawing.js)',
    logLevel: 'silent',
  })
  for (const drawing of drawings) {
    transformSync(`'use strict'; (ctx, frame, helpers) => {\n${drawing.code}\n}`, {
      loader: 'js',
      sourcefile: drawing.name,
      logLevel: 'silent',
    })
  }
}

export function checkBundledExplainerSyntax(
  drawings: ReadonlyArray<{ name: string; code: string }> = [],
): void {
  assertExplainerSyntax(
    readFileSync('assets/explainers/player.html', 'utf8'),
    readFileSync('assets/explainers/drawing.js', 'utf8'),
    drawings,
  )
}
