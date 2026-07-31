// Generate the published JSON Schema for the headless automation contract
// (issue #1079) from its single source of truth — the zod declarations in
// `packages/agent/src/headless-contract.ts`. Writes
// `schemas/headless-contract.schema.json`, matching the existing
// `schemas/*.schema.json` convention so external (non-TypeScript) adapters have a
// stable contract file.
//
// The module is bundled with esbuild (resolving the `@copse/*` aliases the way
// the test/bench launchers do) and then required in-process to call its
// `headlessContractJsonSchema()` export — so the emitted schema is generated from
// exactly the same declaration the TypeScript types are inferred from.
//
// Usage:
//   node scripts/gen-headless-schema.mts            # write the schema file
//   node scripts/gen-headless-schema.mts --check    # fail if the file is stale
import * as esbuild from 'esbuild'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCHEMA_PATH = resolve('schemas/headless-contract.schema.json')
const out = resolve('dist-test/headless-contract.cjs')

function isSchemaModule(
  value: unknown,
): value is { headlessContractJsonSchema: () => Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'headlessContractJsonSchema' in value &&
    typeof value.headlessContractJsonSchema === 'function'
  )
}

await esbuild.build({
  entryPoints: [resolve('packages/agent/src/headless-contract.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: false,
  alias: {
    '@shared': resolve('./src/shared'),
    '@copse/agent': resolve('./packages/agent/src'),
    '@copse/llm': resolve('./packages/llm/src'),
  },
})

const require = createRequire(import.meta.url)
const mod: unknown = require(out)
if (!isSchemaModule(mod)) throw new Error('Bundled headless contract does not export its schema')
const serialized = `${JSON.stringify(mod.headlessContractJsonSchema(), null, 2)}\n`

if (process.argv.includes('--check')) {
  let current: string
  try {
    current = readFileSync(SCHEMA_PATH, 'utf8')
  } catch {
    current = ''
  }
  if (current !== serialized) {
    console.error(
      'schemas/headless-contract.schema.json is stale. Run `npm run gen:headless-schema` and commit.',
    )
    process.exit(1)
  }
  console.log('headless-contract schema is up to date.')
} else {
  writeFileSync(SCHEMA_PATH, serialized, 'utf8')
  console.log(`Wrote ${SCHEMA_PATH}`)
}
