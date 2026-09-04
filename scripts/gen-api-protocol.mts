// Generate the published JSON Schema for the renderer ↔ main API protocol
// (issue #2312, step 1) from its sources — the `ApiClient` interface in
// `src/preload/api.d.ts` and the channel bindings in `src/preload/index.ts` —
// and write `schemas/api-protocol.schema.json`. See `scripts/lib/api-protocol.mts`
// for what the document contains and `docs/api-protocol.md` for how to change
// the surface deliberately.
//
// Usage:
//   node scripts/gen-api-protocol.mts                       # write the schema file
//   node scripts/gen-api-protocol.mts --check               # fail if the file is stale
//   node scripts/gen-api-protocol.mts --compare-ref <ref>   # classify the change from
//                                                           # the schema at a git ref
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { API_PROTOCOL_VERSION } from '../src/shared/api-protocol.mts'
import {
  API_PROTOCOL_SCHEMA_PATH,
  compareApiProtocol,
  generateApiProtocol,
  parseApiProtocol,
  serializeApiProtocol,
} from './lib/api-protocol.mts'

const schemaPath = resolve(API_PROTOCOL_SCHEMA_PATH)
const args = process.argv.slice(2)
const doc = generateApiProtocol({ version: API_PROTOCOL_VERSION })
const serialized = serializeApiProtocol(doc)

const compareIndex = args.indexOf('--compare-ref')
if (compareIndex !== -1) {
  const ref = args[compareIndex + 1]
  if (!ref) {
    console.error('--compare-ref needs a git ref')
    process.exit(2)
  }
  const previous = parseApiProtocol(
    execFileSync('git', ['show', `${ref}:${API_PROTOCOL_SCHEMA_PATH}`], { encoding: 'utf8' }),
  )
  const diff = compareApiProtocol(previous, doc)
  for (const line of diff.additive) console.log(`additive  ${line}`)
  for (const line of diff.breaking) console.log(`BREAKING  ${line}`)
  const bumped = doc.version > previous.version
  console.log(
    `${String(diff.additive.length)} additive, ${String(diff.breaking.length)} breaking; ` +
      `version ${String(previous.version)} → ${String(doc.version)}`,
  )
  if (diff.breaking.length > 0 && !bumped) {
    console.error(
      'Breaking change to the API protocol without a version bump. ' +
        'Bump API_PROTOCOL_VERSION in src/shared/api-protocol.mts or make the change additive.',
    )
    process.exit(1)
  }
  process.exit(0)
}

if (args.includes('--check')) {
  let current: string
  try {
    current = readFileSync(schemaPath, 'utf8')
  } catch {
    current = ''
  }
  if (current !== serialized) {
    console.error(
      `${API_PROTOCOL_SCHEMA_PATH} is stale. Run \`pnpm run gen:api-protocol\` and commit.`,
    )
    process.exit(1)
  }
  console.log('api-protocol schema is up to date.')
} else {
  writeFileSync(schemaPath, serialized, 'utf8')
  const invoke = Object.keys(doc.channels.invoke).length
  const send = Object.keys(doc.channels.send).length
  const event = Object.keys(doc.channels.event).length
  const defs = Object.keys(doc.$defs).length
  console.log(
    `Wrote ${schemaPath}: v${String(doc.version)}, ${String(invoke)} invoke + ${String(send)} send + ` +
      `${String(event)} event channels, ${String(defs)} named types`,
  )
}
