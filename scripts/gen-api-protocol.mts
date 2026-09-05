// Generate the renderer ↔ main API protocol (issue #2312, step 1) from its
// sources — the `ApiClient` interface in `src/preload/api.d.ts` and the channel
// bindings in `src/preload/index.ts`. Writes the committed manifest
// (`schemas/api-protocol.manifest.json`); the full JSON Schema is a build output.
// See `scripts/lib/api-protocol.mts` for what the documents contain and
// `docs/api-protocol.md` for how to change the surface deliberately.
//
// Usage:
//   node scripts/gen-api-protocol.mts                       # write the manifest
//   node scripts/gen-api-protocol.mts --check               # fail if the manifest is stale
//   node scripts/gen-api-protocol.mts --schema [path]       # also write the full schema
//                                                           # (default: dist/schemas/…)
//   node scripts/gen-api-protocol.mts --compare-ref <ref>   # classify the change from
//                                                           # the protocol at a git ref
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { API_PROTOCOL_VERSION } from '../src/shared/api-protocol.mts'
import {
  API_PROTOCOL_MANIFEST_PATH,
  API_PROTOCOL_SCHEMA_BUILD_PATH,
  compareApiProtocol,
  generateApiProtocol,
  generateApiProtocolAtRef,
  manifestOf,
  serializeApiProtocol,
  serializeApiProtocolManifest,
} from './lib/api-protocol.mts'

/** Where the version lives; a ref without this file predates the protocol. */
const VERSION_MODULE = 'src/shared/api-protocol.mts'

const manifestPath = resolve(API_PROTOCOL_MANIFEST_PATH)
const args = process.argv.slice(2)
const doc = generateApiProtocol({ version: API_PROTOCOL_VERSION })
const manifest = serializeApiProtocolManifest(manifestOf(doc))

const compareIndex = args.indexOf('--compare-ref')
if (compareIndex !== -1) {
  const ref = args[compareIndex + 1]
  if (!ref) {
    console.error('--compare-ref needs a git ref')
    process.exit(2)
  }
  const previousVersion = versionAtRef(ref)
  if (previousVersion === 'pre-protocol') {
    // The ref predates the protocol itself — the case on the PR that
    // introduces it, where `main` has no `api-protocol.mts` to read a version
    // from. There is no previous surface, so every channel is new and nothing
    // can be breaking.
    console.log(`${ref} has no API protocol to compare against; nothing to classify`)
    process.exit(0)
  }
  const previous = generateApiProtocolAtRef(ref, previousVersion)
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
    current = readFileSync(manifestPath, 'utf8')
  } catch {
    current = ''
  }
  if (current !== manifest) {
    console.error(
      `${API_PROTOCOL_MANIFEST_PATH} is stale. Run \`pnpm run gen:api-protocol\` and commit.`,
    )
    process.exit(1)
  }
  console.log('api-protocol manifest is up to date.')
} else {
  writeFileSync(manifestPath, manifest, 'utf8')
  const invoke = Object.keys(doc.channels.invoke).length
  const send = Object.keys(doc.channels.send).length
  const event = Object.keys(doc.channels.event).length
  console.log(
    `Wrote ${manifestPath}: v${String(doc.version)}, ${String(invoke)} invoke + ${String(send)} send + ` +
      `${String(event)} event channels`,
  )
}

const schemaIndex = args.indexOf('--schema')
if (schemaIndex !== -1) {
  const next = args[schemaIndex + 1]
  const out = resolve(next && !next.startsWith('--') ? next : API_PROTOCOL_SCHEMA_BUILD_PATH)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, serializeApiProtocol(doc), 'utf8')
  console.log(`Wrote ${out}: ${String(Object.keys(doc.$defs).length)} named types`)
}

/** Whether `git` succeeds, used to ask yes/no questions about a ref. */
function gitOk(args: string[]): boolean {
  try {
    execFileSync('git', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * The protocol version the sources at `ref` declared, or `'pre-protocol'` when
 * that ref genuinely predates the protocol module.
 *
 * These two are deliberately distinguished from a ref that cannot be read at
 * all. A base that is missing, unfetched, or misspelled must fail closed:
 * treating it like "no protocol here" would turn the compatibility gate into a
 * check that silently passes whenever CI cannot see the base — the failure
 * mode this step exists to prevent.
 */
function versionAtRef(ref: string): number | 'pre-protocol' {
  if (!gitOk(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) {
    throw new Error(
      `cannot resolve ${ref} — fetch it before comparing (refusing to skip the compatibility check)`,
    )
  }
  if (!gitOk(['cat-file', '-e', `${ref}:${VERSION_MODULE}`])) return 'pre-protocol'
  const source = execFileSync('git', ['show', `${ref}:${VERSION_MODULE}`], { encoding: 'utf8' })
  const match = /API_PROTOCOL_VERSION = (\d+)/.exec(source)
  if (!match?.[1]) throw new Error(`${ref}: cannot read API_PROTOCOL_VERSION`)
  return Number(match[1])
}
