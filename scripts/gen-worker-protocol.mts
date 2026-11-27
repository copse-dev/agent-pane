// Generate the harness worker protocol (`docs/plans/harness-worker-roadmap.md`,
// R2) from the schemas each end of a worker line checks its messages with.
// Writes the committed manifest (`schemas/worker-protocol.manifest.json`); the
// full JSON Schema is a build output.
//
// Usage:
//   node scripts/gen-worker-protocol.mts                  # write the manifest
//   node scripts/gen-worker-protocol.mts --check          # fail if the manifest is stale
//   node scripts/gen-worker-protocol.mts --schema [path]  # also write the full schema
//                                                         # (default: dist/schemas/…)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadWorkerProtocol } from './lib/worker-protocol.mts'

const args = process.argv.slice(2)
const protocol = await loadWorkerProtocol()
const document = protocol.workerProtocolDocument()
const manifest = protocol.serializeWorkerProtocol(protocol.workerProtocolManifest(document))
const manifestPath = resolve(protocol.WORKER_PROTOCOL_MANIFEST_PATH)

if (args.includes('--check')) {
  let onDisk = ''
  try {
    onDisk = readFileSync(manifestPath, 'utf8')
  } catch {
    // Missing counts as stale.
  }
  if (onDisk !== manifest) {
    console.error(
      `${protocol.WORKER_PROTOCOL_MANIFEST_PATH} is stale. Run \`pnpm run gen:worker-protocol\` and commit.`,
    )
    process.exit(1)
  }
  console.log('worker-protocol manifest is up to date.')
} else {
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, manifest)
  console.log(`wrote ${protocol.WORKER_PROTOCOL_MANIFEST_PATH}`)
}

const schemaAt = args.indexOf('--schema')
if (schemaAt !== -1) {
  const next = args[schemaAt + 1]
  const out = resolve(
    next && !next.startsWith('--') ? next : protocol.WORKER_PROTOCOL_SCHEMA_BUILD_PATH,
  )
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, protocol.serializeWorkerProtocol(document))
  console.log(`wrote ${out}`)
}
