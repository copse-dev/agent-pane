// Syntax gate for the e2e tree. tests/e2e is excluded from both tsconfigs and
// from eslint, so a typo in a spec otherwise only surfaces when wdio loads the
// file — after a full build and Electron launch. This parses every spec (and
// the wdio configs) with esbuild, which is the same transform wdio applies, so
// anything that would crash spec loading fails here in milliseconds instead.
//
// Deliberately NOT a typecheck: the directory has never been typechecked and
// making it so is its own cleanup project.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { z } from 'zod'
import { checkBundledExplainerSyntax } from './lib/explainer-syntax.mts'

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (entry.endsWith('.ts')) files.push(full)
  }
  return files
}

const roots = [
  ...walk(join(process.cwd(), 'tests', 'e2e')),
  ...walk(join(process.cwd(), 'tests', 'fixtures')),
  ...readdirSync(process.cwd())
    .filter((name) => /^wdio.*\.conf\.ts$/.test(name))
    .map((name) => join(process.cwd(), name)),
]

let failures = 0
for (const file of roots) {
  try {
    transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' })
  } catch (err) {
    failures += 1
    console.error(`✗ ${file}`)
    console.error(err instanceof Error ? err.message : String(err))
  }
}

if (failures > 0) {
  console.error(`\ncheck-e2e-syntax: ${String(failures)} file(s) failed to parse`)
  process.exit(1)
}
console.log(`check-e2e-syntax: ${String(roots.length)} files parsed cleanly`)

// Only import after the outer fixture syntax passes. TypeScript cannot inspect
// JavaScript held inside template strings; parse those in their worker wrapper.
// The repo is CommonJS. Explicitly transform this data-only fixture to ESM;
// directly importing its .ts file would misclassify its export declarations.
const fixtureModule = transformSync(readFileSync('tests/fixtures/explainer-drawing.ts', 'utf8'), {
  loader: 'ts',
  format: 'esm',
}).code
const imported: unknown = await import(
  `data:text/javascript;base64,${Buffer.from(fixtureModule).toString('base64')}`
)
const drawings = z
  .record(z.string(), z.object({ drawing: z.object({ code: z.string() }) }))
  .parse(imported)
checkBundledExplainerSyntax(
  Object.entries(drawings).map(([name, story]) => ({
    name: `tests/fixtures/explainer-drawing.ts:${name}.drawing.code`,
    code: story.drawing.code,
  })),
)
console.log('check-e2e-syntax: explainer player, worker and drawing bodies parsed cleanly')
