// Fetch the reference CommonMark HTML normalizer (`normalize.py`) used by
// `scripts/check-normalizer-parity.mts` to validate our JS port. We deliberately
// do NOT check this file into the repo — it is the spec's reference code, not
// ours — so we pull it at check time from a pinned upstream commit and verify
// its SHA-256 before use. Pinning by commit + content hash keeps the fetch
// deterministic and tamper-evident; a hash mismatch fails the check.
//
// The `commonmark-spec` npm devDependency ships only `spec.txt` (not the test
// normalizer), so npm cannot provide this file. To bump it: pick a new
// commit SHA from https://github.com/commonmark/commonmark-spec (path
// test/normalize.py), update SHA + EXPECTED_SHA256 below, and re-run.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const COMMIT = '3da939428d80f146f270cd1765e4ba462e96bb1b'
const EXPECTED_SHA256 = '94a9dd253907e3dab7c02fc11e934f06112dcf0f3804255d09d732c8c7c4b5f4'
const URL = `https://raw.githubusercontent.com/commonmark/commonmark-spec/${COMMIT}/test/normalize.py`

const ROOT = resolve(import.meta.dirname, '..')
const DEST = resolve(ROOT, 'tests/commonmark/normalize.py')

const sha256 = (buf: Buffer | Uint8Array): string => createHash('sha256').update(buf).digest('hex')

function die(message: string): never {
  console.error(`fetch-reference-normalizer: ${message}`)
  process.exit(1)
}

if (existsSync(DEST) && sha256(readFileSync(DEST)) === EXPECTED_SHA256) {
  console.log('fetch-reference-normalizer: cached normalize.py is up to date.')
  process.exit(0)
}

const res = await fetch(URL).catch((e: unknown) =>
  die(`download failed: ${e instanceof Error ? e.message : String(e)}`),
)
if (!res.ok) die(`download failed: ${String(res.status)} ${res.statusText} for ${URL}`)
const bytes = new Uint8Array(await res.arrayBuffer())
const actual = sha256(bytes)
if (actual !== EXPECTED_SHA256) {
  die(`SHA-256 mismatch for ${URL}\n  expected ${EXPECTED_SHA256}\n  actual   ${actual}`)
}
writeFileSync(DEST, bytes)
console.log(
  `fetch-reference-normalizer: wrote ${DEST} (verified sha256 ${EXPECTED_SHA256.slice(0, 12)}…).`,
)
